import type { Horizon } from '@stellar/stellar-sdk';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { extractContractAddress, sleep } from '../stellar.js';
import { withRetry } from '../retry.js';
import type { IndexerConfig } from '../config.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'deployments.horizon';
const PAGE_LIMIT = 200;

/**
 * Pages fetched per wallet per tick, during backfill. Bounds how much of a
 * tick one wallet with a very long history can consume — bigger histories
 * just take more ticks to finish, instead of starving every other wallet's
 * turn (or blowing the tick interval) in one go.
 */
const MAX_PAGES_PER_TICK = 10;

export interface DeploymentResult {
  highestLedger: number;
  walletsScanned: number;
  contractsFound: number;
}

/** A tracked wallet, as far as this worker is concerned. */
export interface DeploymentWallet {
  id: string;
  pubkey: string;
  /** Resume point for the one-time backward (desc) backfill walk; null once backfillComplete. */
  operationsCursor: string | null;
  /** Newest paging_token ever observed — where the steady-state forward (asc) catch-up scan resumes from. */
  operationsWatermark: string | null;
  /** True once the backward walk has reached the account's very first operation. */
  backfillComplete: boolean;
}

/** Fields written to a `Contract` row on create. */
export interface ContractCreate {
  address: string;
  walletId: string;
  deployerPubkey: string;
  deployedAt: Date;
  deployTxHash: string;
  network: string;
}

/** Progress fields persisted after every page, so a crash mid-walk resumes rather than restarts. */
interface ProgressUpdate {
  operationsCursor: string | null;
  operationsWatermark: string | null;
  backfillComplete: boolean;
}

/**
 * The persistence surface this worker needs. Declaring it as an interface is
 * what lets the backfill/resume/dedup behavior be tested without a database.
 */
export interface DeploymentStore {
  wallet: {
    findMany: () => Promise<DeploymentWallet[]>;
    update: (args: { where: { id: string }; data: ProgressUpdate }) => Promise<unknown>;
  };
  contract: {
    findFirst: (args: { where: { deployTxHash: string } }) => Promise<{ id: string } | null>;
    upsert: (args: {
      where: { address: string };
      update: Record<string, never>;
      create: ContractCreate;
    }) => Promise<unknown>;
  };
}

/** One page of Horizon operations for `pubkey`, in `order`, starting after `cursor`. */
async function fetchPage(
  horizon: Horizon.Server,
  pubkey: string,
  order: 'asc' | 'desc',
  cursor: string | null,
) {
  let builder = horizon.operations().forAccount(pubkey).order(order).limit(PAGE_LIMIT);
  if (cursor) builder = builder.cursor(cursor);
  return withRetry(() => builder.call(), { label: RETRY_LABEL });
}

/**
 * Process one page's records for CreateContract deployments, upserting new
 * ones and returning the highest ledger sequence observed on the page.
 */
async function processPage(
  store: DeploymentStore,
  wallet: DeploymentWallet,
  horizon: Horizon.Server,
  config: IndexerConfig,
  records: Horizon.ServerApi.OperationRecord[],
): Promise<{ highestLedger: number; newContracts: number }> {
  let highestLedger = 0;
  let newContracts = 0;

  for (const op of records) {
    if (op.paging_token) {
      const ledgerSeq = Math.floor(Number(op.paging_token) / 4294967296);
      if (ledgerSeq > highestLedger) highestLedger = ledgerSeq;
    }

    if (op.type !== 'invoke_host_function') continue;

    // The SDK's operation type narrowing — use any to access function field
    // which is present on InvokeHostFunction operations from Horizon
    const opRecord = op as unknown as Record<string, unknown>;
    if (opRecord['function'] !== 'HostFunctionTypeCreateContract') continue;

    const txHash = op.transaction_hash;
    if (!txHash) continue;

    const existing = await store.contract.findFirst({ where: { deployTxHash: txHash } });
    if (existing) continue;

    await sleep(RATE_LIMIT_DELAY_MS);
    try {
      const tx = await withRetry(
        () => horizon.transactions().transaction(txHash).call(),
        { label: RETRY_LABEL },
      );
      const contractAddress = extractContractAddress(tx.result_meta_xdr);
      const ledgerSeq = tx.ledger_attr;
      if (typeof ledgerSeq === 'number' && ledgerSeq > highestLedger) {
        highestLedger = ledgerSeq;
      }

      if (contractAddress) {
        await store.contract.upsert({
          where:  { address: contractAddress },
          update: {},
          create: {
            address:        contractAddress,
            walletId:       wallet.id,
            deployerPubkey: wallet.pubkey,
            deployedAt:     new Date(tx.created_at),
            deployTxHash:   txHash,
            network:        config.network,
          },
        });
        newContracts++;
        logger.debug({ pubkey: wallet.pubkey, contract: contractAddress }, 'deployments.found');
      }
    } catch (txErr) {
      logger.warn(
        { pubkey: wallet.pubkey, txHash, error: String(txErr) },
        'deployments.txFetchFailed',
      );
    }
  }

  return { highestLedger, newContracts };
}

/**
 * Walk up to MAX_PAGES_PER_TICK pages for one wallet — backward (desc) from
 * wallet.operationsCursor while backfill is incomplete, or forward (asc) from
 * wallet.operationsWatermark once it's caught up to the account's full
 * history. Persists progress after every page, so a crash or restart mid-walk
 * resumes from the last completed page rather than starting over.
 */
async function walkWallet(
  store: DeploymentStore,
  wallet: DeploymentWallet,
  horizon: Horizon.Server,
  config: IndexerConfig,
): Promise<{ highestLedger: number; newContracts: number }> {
  let highestLedger = 0;
  let newContracts = 0;

  const backfilling = !wallet.backfillComplete;
  let cursor = backfilling ? wallet.operationsCursor : wallet.operationsWatermark;
  let watermark = wallet.operationsWatermark;

  for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
    const ops = await fetchPage(horizon, wallet.pubkey, backfilling ? 'desc' : 'asc', cursor);
    await sleep(RATE_LIMIT_DELAY_MS);

    const records = ops.records;
    if (records.length === 0) {
      if (backfilling) {
        // Reached the account's very first operation (or it has none at all).
        await store.wallet.update({
          where: { id: wallet.id },
          data: { operationsCursor: null, operationsWatermark: watermark, backfillComplete: true },
        });
      }
      break;
    }

    if (watermark === null) {
      // The newest record of the very first page this wallet has ever had
      // fetched — this is where steady-state catch-up resumes from later,
      // regardless of how many backfill ticks it takes to reach genesis.
      watermark = records[0]!.paging_token ?? null;
    }

    const result = await processPage(store, wallet, horizon, config, records);
    highestLedger = Math.max(highestLedger, result.highestLedger);
    newContracts += result.newContracts;

    const last = records[records.length - 1]!.paging_token ?? null;
    const reachedEnd = records.length < PAGE_LIMIT;

    if (backfilling) {
      cursor = reachedEnd ? null : last;
      await store.wallet.update({
        where: { id: wallet.id },
        data: {
          operationsCursor: cursor,
          operationsWatermark: watermark,
          backfillComplete: reachedEnd,
        },
      });
      if (reachedEnd) break;
    } else {
      cursor = last;
      watermark = last;
      await store.wallet.update({
        where: { id: wallet.id },
        data: { operationsCursor: null, operationsWatermark: watermark, backfillComplete: true },
      });
      if (reachedEnd) break;
    }
  }

  return { highestLedger, newContracts };
}

export async function runDeploymentWorker(
  horizon: Horizon.Server,
  config: IndexerConfig,
  store: DeploymentStore = prisma as unknown as DeploymentStore,
): Promise<DeploymentResult> {
  const wallets = await store.wallet.findMany();
  let highestLedger = 0;
  let contractsFound = 0;

  for (const wallet of wallets) {
    logger.debug(
      { pubkey: wallet.pubkey, backfillComplete: wallet.backfillComplete },
      'deployments.scanning',
    );
    try {
      const { highestLedger: walletHighest, newContracts } = await walkWallet(
        store,
        wallet,
        horizon,
        config,
      );
      highestLedger = Math.max(highestLedger, walletHighest);
      contractsFound += newContracts;
      logger.debug({ pubkey: wallet.pubkey, new: newContracts }, 'deployments.walletDone');
    } catch (err) {
      logger.error({ pubkey: wallet.pubkey, error: String(err) }, 'deployments.scanFailed');
    }
  }

  return { highestLedger, walletsScanned: wallets.length, contractsFound };
}
