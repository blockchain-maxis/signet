import type { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';
import { extractContractAddress, sleep } from '../stellar.js';
import { withRetry } from '../retry.js';
import type { IndexerConfig } from '../config.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'deployments.horizon';

export interface DeploymentResult {
  highestLedger: number;
  walletsScanned: number;
  contractsFound: number;
}

/** A tracked wallet, as far as this worker is concerned. */
export interface DeploymentWallet {
  id: string;
  pubkey: string;
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

/**
 * The persistence surface the worker needs — the injectable seam that keeps
 * wallet discovery testable without a database. Production passes Prisma;
 * tests pass an in-memory store. Mirrors the `OperationsStore` pattern in
 * `operations.ts`. Calling `wallet.findMany()` fresh on every invocation (not
 * once at startup) is what lets a wallet linked after the indexer started get
 * scanned on the very next tick, with no restart.
 */
export interface DeploymentStore {
  wallet: { findMany: () => Promise<DeploymentWallet[]> };
  contract: {
    findFirst: (args: { where: { deployTxHash: string } }) => Promise<{ id: string } | null>;
    upsert: (args: {
      where: { address: string };
      update: Record<string, never>;
      create: ContractCreate;
    }) => Promise<unknown>;
  };
}

export async function runDeploymentWorker(
  horizon: Horizon.Server,
  config: IndexerConfig,
  store: DeploymentStore,
): Promise<DeploymentResult> {
  const wallets = await store.wallet.findMany();
  let highestLedger = 0;
  let contractsFound = 0;

  for (const wallet of wallets) {
    logger.debug({ pubkey: wallet.pubkey }, 'deployments.scanning');
    let newCount = 0;

    try {
      const ops = await withRetry(
        () =>
          horizon
            .operations()
            .forAccount(wallet.pubkey)
            .order('desc')
            .limit(200)
            .call(),
        { label: RETRY_LABEL },
      );

      await sleep(RATE_LIMIT_DELAY_MS);

      for (const op of ops.records) {
        // Track highest ledger seen
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

        // Skip if we already have a contract from this tx
        const existing = await store.contract.findFirst({
          where: { deployTxHash: txHash },
        });
        if (existing) continue;

        // Fetch transaction to parse contract address from result meta
        await sleep(RATE_LIMIT_DELAY_MS);
        let contractAddress: string | null = null;

        try {
          const tx = await withRetry(
            () => horizon.transactions().transaction(txHash).call(),
            { label: RETRY_LABEL },
          );
          contractAddress = extractContractAddress(tx.result_meta_xdr);
          const ledgerSeq = tx.ledger_attr;
          if (typeof ledgerSeq === 'number' && ledgerSeq > highestLedger) {
            highestLedger = ledgerSeq;
          }

          if (contractAddress) {
            await store.contract.upsert({
              where:  { address: contractAddress },
              update: {},
              create: {
                address:       contractAddress,
                walletId:      wallet.id,
                deployerPubkey: wallet.pubkey,
                deployedAt:    new Date(tx.created_at),
                deployTxHash:  txHash,
                network:       config.network,
              },
            });
            newCount++;
            logger.debug(
              { pubkey: wallet.pubkey, contract: contractAddress },
              'deployments.found',
            );
          }
        } catch (txErr) {
          logger.warn(
            { pubkey: wallet.pubkey, txHash, error: String(txErr) },
            'deployments.txFetchFailed',
          );
        }
      }
    } catch (err) {
      logger.error(
        { pubkey: wallet.pubkey, error: String(err) },
        'deployments.scanFailed',
      );
    }

    contractsFound += newCount;
    logger.debug({ pubkey: wallet.pubkey, new: newCount }, 'deployments.walletDone');
  }

  return { highestLedger, walletsScanned: wallets.length, contractsFound };
}
