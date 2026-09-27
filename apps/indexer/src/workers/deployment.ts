import type { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';
import { extractContractAddress, sleep } from '../stellar.js';
import { withRetry } from '../retry.js';
import type { IndexerConfig } from '../config.js';
import type { ContractExecutableInfo, ReadExecutable } from '../contract-executable.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'deployments.horizon';

/**
 * Page size and per-tick page cap for a wallet still being backfilled —
 * matches operations.ts's own constants, for the same reason: bound how much
 * one very-busy wallet can cost a single tick, so it catches up over
 * subsequent ticks instead of stalling the whole run.
 */
const PER_WALLET_LIMIT = 50;
const MAX_PAGES_PER_TICK = 10;

/** Once a wallet's backlog fits in one page, skip the paginated backfill path entirely. */
const QUICK_CHECK_LIMIT = 200;

export interface DeploymentResult {
  highestLedger: number;
  walletsScanned: number;
  contractsFound: number;
}

/** A tracked wallet, as far as this worker is concerned. */
export interface DeploymentWallet {
  id: string;
  pubkey: string;
  /**
   * The Horizon paging_token of the oldest operation walked back to so far —
   * see the schema comment on Wallet.deploymentCursor. `null` means backfill
   * hasn't started (a fresh wallet, or one linked before this worker existed).
   */
  deploymentCursor: string | null;
  /** Set once the backward walk has reached the end of this wallet's history. */
  deploymentBackfilledAt: Date | null;
  /**
   * The Horizon paging_token of the newest operation examined so far — see the
   * schema comment on Wallet.deploymentWatermark. Where deploymentCursor walks
   * backwards and stops, this walks forwards and never does. `null` means no
   * forward position yet, and the first post-backfill tick falls back to a
   * bounded newest-first window to establish one.
   */
  deploymentWatermark: string | null;
  /**
   * Set by `apps/web/lib/server/account.ts`'s `linkDeployWallet` on every
   * (re-)link, so a just-linked wallet gets scanned promptly instead of
   * waiting out the rest of the current tick interval — see
   * `apps/indexer/src/index.ts`'s idle-sleep loop, which polls for any wallet
   * with this set and starts the next tick early. Cleared here once the
   * wallet has actually been scanned (success or failure — a scan was
   * *attempted* promptly either way, and leaving it set after a transient
   * Horizon failure would keep forcing short ticks for as long as Horizon
   * stays down).
   */
  indexRequestedAt: Date | null;
}

/** Fields written to a `Contract` row on create. */
export interface ContractCreate {
  address: string;
  walletId: string;
  deployerPubkey: string;
  deployedAt: Date;
  deployTxHash: string;
  network: string;
  /**
   * Lowercase 64-char SHA-256 hex of the instance's WASM executable, read from
   * chain at discovery time. `null` when the instance was already archived or
   * Soroban RPC could not be reached.
   */
  wasmHash: string | null;
  /** `'wasm'` | `'stellar_asset'`, or `null` when neither could be determined. */
  executableType: string | null;
  /**
   * When the executable was identified. Left `null` on a miss deliberately:
   * #416's refresh worker selects on `wasmHashCheckedAt IS NULL`, so an
   * unread row is due for a backfill at once rather than after one interval.
   */
  wasmHashCheckedAt: Date | null;
}

/**
 * The persistence surface the worker needs — the injectable seam that keeps
 * wallet discovery testable without a database. Production passes Prisma;
 * tests pass an in-memory store. Mirrors the `OperationsStore` pattern in
 * `operations.ts`. Calling `wallet.findMany()` fresh on every invocation (not
 * once at startup) is what lets a wallet linked after the indexer started get
 * scanned on the very next tick, with no restart.
 *
 * The same seam is what lets a test seed a contract already recorded under one
 * wallet and verify a second wallet's scan neither re-inserts nor re-attributes
 * it, drive the backfill-resumption and completion logic, and check that
 * indexRequestedAt is cleared — all without a database.
 */
export interface DeploymentStore {
  wallet: {
    findMany: () => Promise<DeploymentWallet[]>;
    update: (args: {
      where: { id: string };
      data: {
        deploymentCursor?: string | null;
        deploymentBackfilledAt?: Date;
        deploymentWatermark?: string | null;
        indexRequestedAt?: null;
      };
    }) => Promise<unknown>;
  };
  contract: {
    findFirst: (args: {
      where: { deployTxHash: string } | { address: string };
    }) => Promise<{ id: string } | null>;
    upsert: (args: {
      where: { address: string };
      update: Record<string, never>;
      create: ContractCreate;
    }) => Promise<{ id: string } | null>;
  };
  /**
   * Only written when discovery found a WASM executable: the first entry in the
   * contract's version history. `#416`'s refresh worker upserts the same
   * unique pair, so a re-run adds nothing.
   */
  contractWasmVersion: {
    upsert: (args: {
      where: { contractId_wasmHash: { contractId: string; wasmHash: string } };
      update: Record<string, never>;
      create: { contractId: string; wasmHash: string; observedLedger: number };
    }) => Promise<unknown>;
  };
}

/** The slice of a Horizon `CollectionPage` the pagination loop walks — see operations.ts's identical type. */
interface OperationsPage {
  records: Horizon.ServerApi.OperationRecord[];
  next: () => Promise<OperationsPage>;
}

/** Mutable per-tick state threaded through the per-operation handler, so it can update the caller's totals. */
interface ScanState {
  highestLedger: number;
  newContracts: number;
  walletUndecodedMetaCount: number;
  walletUndecodedMetaVersions: Set<number | string>;
}

/**
 * Handle one Horizon operation: track the highest ledger seen, and — for a
 * create-contract invocation not already recorded — fetch its transaction,
 * extract the deployed address, read the instance's executable off chain, and
 * upsert the Contract row. Shared between the quick-check path (an already-
 * backfilled wallet) and the paginated backfill path, so both apply the exact
 * same dedup and extraction logic.
 */
async function handleOperation(
  op: Horizon.ServerApi.OperationRecord,
  wallet: DeploymentWallet,
  horizon: Horizon.Server,
  config: IndexerConfig,
  store: DeploymentStore,
  state: ScanState,
  readExecutable: ReadExecutable | undefined,
): Promise<void> {
  if (op.paging_token) {
    const ledgerSeq = Math.floor(Number(op.paging_token) / 4294967296);
    if (ledgerSeq > state.highestLedger) state.highestLedger = ledgerSeq;
  }

  if (op.type !== 'invoke_host_function') return;

  // The SDK's operation type narrowing — use any to access function field
  // which is present on InvokeHostFunction operations from Horizon
  const opRecord = op as unknown as Record<string, unknown>;
  if (opRecord['function'] !== 'HostFunctionTypeCreateContract') return;

  const txHash = op.transaction_hash;
  if (!txHash) return;

  const existing = await store.contract.findFirst({ where: { deployTxHash: txHash } });
  if (existing) return;

  await sleep(RATE_LIMIT_DELAY_MS);

  try {
    const tx = await withRetry(() => horizon.transactions().transaction(txHash).call(), {
      label: RETRY_LABEL,
    });
    const extraction = extractContractAddress(tx.result_meta_xdr);
    const ledgerSeq: number = typeof tx.ledger_attr === 'number' ? tx.ledger_attr : 0;
    if (ledgerSeq > state.highestLedger) state.highestLedger = ledgerSeq;

    if (extraction.ok) {
      const contractAddress = extraction.address;
      // `Contract.address` carries the real uniqueness constraint, and it is
      // the identifier guaranteed not to collide once a profile holds more
      // than one linked wallet: the same contract can be reached from more
      // than one wallet's scan path, each surfacing its own transaction hash.
      // Deduping on `deployTxHash` alone would re-insert — or, via a careless
      // upsert `update`, silently re-attribute — a contract already recorded
      // under a different wallet. The upsert below is safe on its own, but
      // this check is what keeps a re-discovery from logging as new or
      // double-counting `newContracts`. (Kept from #340; this worker's
      // backfill walks far more history, so it hits the case more often.)
      const existingByAddress = await store.contract.findFirst({
        where: { address: contractAddress },
      });
      if (existingByAddress) {
        logger.debug(
          { pubkey: wallet.pubkey, contract: contractAddress },
          'deployments.alreadyRecorded',
        );
        return;
      }

      // For a freshly-deployed contract the instance is still live, so this is
      // one RPC read. The old deployments #372's backward walk recovers are
      // usually archived, which makes a `null` here the common case rather
      // than the exception — hence the row is created regardless: losing a
      // discovery would be far worse than losing a hash, and #416 backfills
      // it. Its own try/catch for the same reason: a read that *throws* must
      // not reach the outer handler, which would skip the insert.
      let executable: ContractExecutableInfo | null = null;
      let executableError: string | undefined;
      if (readExecutable) {
        try {
          executable = await readExecutable(contractAddress);
        } catch (err) {
          executableError = String(err);
        }
      }
      if (!executable) {
        const fields = {
          pubkey: wallet.pubkey,
          contract: contractAddress,
          ...(executableError ? { error: executableError } : {}),
        };
        // A plain miss is the expected outcome for an archived instance, so it
        // stays at debug; a read that actually failed deserves to be seen.
        if (executableError) logger.warn(fields, 'deployments.executableUnavailable');
        else logger.debug(fields, 'deployments.executableUnavailable');
      }

      const created = await store.contract.upsert({
        where: { address: contractAddress },
        update: {},
        create: {
          address: contractAddress,
          walletId: wallet.id,
          deployerPubkey: wallet.pubkey,
          deployedAt: new Date(tx.created_at),
          deployTxHash: txHash,
          network: config.network,
          wasmHash: executable?.type === 'wasm' ? executable.wasmHash : null,
          executableType: executable ? executable.type : null,
          wasmHashCheckedAt: executable ? new Date() : null,
        },
      });

      if (executable?.type === 'wasm' && created) {
        await store.contractWasmVersion.upsert({
          where: {
            contractId_wasmHash: { contractId: created.id, wasmHash: executable.wasmHash },
          },
          update: {},
          create: {
            contractId: created.id,
            wasmHash: executable.wasmHash,
            observedLedger: ledgerSeq,
          },
        });
      }

      state.newContracts++;
      logger.debug({ pubkey: wallet.pubkey, contract: contractAddress }, 'deployments.found');
    } else {
      // Create-contract operation whose meta could not be decoded.
      // Because the cursor and watermark move past these operations anyway,
      // the log line emitted at the end of the wallet scan is the only trace they leave.
      state.walletUndecodedMetaCount++;
      if (extraction.metaVersion !== undefined) {
        state.walletUndecodedMetaVersions.add(extraction.metaVersion);
      }
    }
  } catch (txErr) {
    logger.warn(
      { pubkey: wallet.pubkey, txHash, error: String(txErr) },
      'deployments.txFetchFailed',
    );
  }
}

/**
 * A wallet whose backfill already completed: walk *forward* from where the
 * last tick finished.
 *
 * The obvious implementation — read the newest N operations each tick — is
 * anchored to now rather than to how far the worker actually got, so anything
 * that falls out of that window between two ticks is never examined again:
 * the backward walk is finished and will not revisit it. A deploy script, a
 * busy testnet key, or a long idle interval all reach that, and the failure is
 * invisible (the profile just quietly misses contracts). So the position is
 * persisted, and the scan resumes from it.
 *
 * With no watermark yet (the first tick after backfill, or a wallet backfilled
 * before this column existed) it falls back to one bounded newest-first page,
 * which is the previous behaviour, and records a watermark from it so every
 * later tick resumes properly.
 */
async function quickCheck(
  wallet: DeploymentWallet,
  horizon: Horizon.Server,
  config: IndexerConfig,
  store: DeploymentStore,
  state: ScanState,
  readExecutable: ReadExecutable | undefined,
): Promise<void> {
  if (!wallet.deploymentWatermark) {
    await seedWatermark(wallet, horizon, config, store, state, readExecutable);
    return;
  }

  let page = (await withRetry(
    () =>
      horizon
        .operations()
        .forAccount(wallet.pubkey)
        .order('asc')
        .limit(PER_WALLET_LIMIT)
        .cursor(wallet.deploymentWatermark as string)
        .call(),
    { label: RETRY_LABEL },
  )) as unknown as OperationsPage;
  await sleep(RATE_LIMIT_DELAY_MS);

  let watermark = wallet.deploymentWatermark;
  let pagesRead = 0;

  while (true) {
    for (const op of page.records) {
      await handleOperation(op, wallet, horizon, config, store, state, readExecutable);
      if (op.paging_token) watermark = op.paging_token;
    }
    pagesRead++;

    // Persisted per page, not once at the end: a crash mid-walk would
    // otherwise re-read every page since the tick began, and on a wallet
    // that is behind by thousands of operations that is the difference
    // between making progress and never catching up.
    if (watermark !== wallet.deploymentWatermark) {
      await store.wallet.update({
        where: { id: wallet.id },
        data: { deploymentWatermark: watermark },
      });
    }

    if (page.records.length === 0) break;
    if (pagesRead >= MAX_PAGES_PER_TICK) {
      logger.debug({ pubkey: wallet.pubkey, pagesRead }, 'deployments.catchUpPaused');
      break;
    }

    try {
      page = await withRetry(() => page.next(), { label: RETRY_LABEL });
    } catch {
      break;
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }
}

/**
 * Establish a forward position for a wallet that has none, by reading one
 * bounded newest-first page. Deliberately not a walk: the backward backfill
 * has already covered this wallet's history, so all this needs to do is mark
 * where "now" is and let the forward scan take over next tick.
 */
async function seedWatermark(
  wallet: DeploymentWallet,
  horizon: Horizon.Server,
  config: IndexerConfig,
  store: DeploymentStore,
  state: ScanState,
  readExecutable: ReadExecutable | undefined,
): Promise<void> {
  const ops = await withRetry(
    () =>
      horizon.operations().forAccount(wallet.pubkey).order('desc').limit(QUICK_CHECK_LIMIT).call(),
    { label: RETRY_LABEL },
  );
  await sleep(RATE_LIMIT_DELAY_MS);

  // Newest-first, so the first record is the newest and becomes the watermark.
  const newest = ops.records[0]?.paging_token ?? null;

  for (const op of ops.records) {
    await handleOperation(op, wallet, horizon, config, store, state, readExecutable);
  }

  if (newest) {
    await store.wallet.update({
      where: { id: wallet.id },
      data: { deploymentWatermark: newest },
    });
  }
}

/**
 * A wallet still being backfilled: resume the backward walk exactly where
 * `deploymentCursor` left off (Horizon's own `.cursor()` — omitted on the
 * very first backfill tick, which starts at the newest operation), and
 * persist how far it got. Bounded to MAX_PAGES_PER_TICK pages so one very
 * deep history can't stall the whole tick; it picks up next time from the
 * cursor this tick saved, rather than re-walking from the top.
 */
async function backfill(
  wallet: DeploymentWallet,
  horizon: Horizon.Server,
  config: IndexerConfig,
  store: DeploymentStore,
  state: ScanState,
  readExecutable: ReadExecutable | undefined,
): Promise<void> {
  let page = (await withRetry(
    () => {
      const query = horizon
        .operations()
        .forAccount(wallet.pubkey)
        .order('desc')
        .limit(PER_WALLET_LIMIT);
      return (wallet.deploymentCursor ? query.cursor(wallet.deploymentCursor) : query).call();
    },
    { label: RETRY_LABEL },
  )) as unknown as OperationsPage;
  await sleep(RATE_LIMIT_DELAY_MS);

  let cursor = wallet.deploymentCursor;
  let pagesRead = 0;
  let reachedEnd = false;

  while (true) {
    for (const op of page.records) {
      await handleOperation(op, wallet, horizon, config, store, state, readExecutable);
      if (op.paging_token) cursor = op.paging_token;
    }
    pagesRead++;

    // Persisted per page rather than once after the loop: a crash partway
    // through a tick would otherwise discard up to MAX_PAGES_PER_TICK pages of
    // walking and redo them next time.
    if (cursor !== wallet.deploymentCursor) {
      await store.wallet.update({
        where: { id: wallet.id },
        data: { deploymentCursor: cursor },
      });
    }

    if (page.records.length === 0) {
      reachedEnd = true;
      break;
    }
    if (pagesRead >= MAX_PAGES_PER_TICK) {
      logger.debug({ pubkey: wallet.pubkey, pagesRead }, 'deployments.maxPagesReached');
      break;
    }

    try {
      page = await withRetry(() => page.next(), { label: RETRY_LABEL });
    } catch {
      reachedEnd = true;
      break;
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // The cursor is already saved by the per-page write above; the only thing
  // left to record is that the walk reached the end.
  if (reachedEnd) {
    await store.wallet.update({
      where: { id: wallet.id },
      data: { deploymentCursor: cursor, deploymentBackfilledAt: new Date() },
    });
  }
}

export async function runDeploymentWorker(
  horizon: Horizon.Server,
  config: IndexerConfig,
  store: DeploymentStore,
  readExecutable?: ReadExecutable,
): Promise<DeploymentResult> {
  const wallets = await store.wallet.findMany();
  const state: ScanState = {
    highestLedger: 0,
    newContracts: 0,
    walletUndecodedMetaCount: 0,
    walletUndecodedMetaVersions: new Set(),
  };

  for (const wallet of wallets) {
    logger.debug({ pubkey: wallet.pubkey }, 'deployments.scanning');
    const before = state.newContracts;
    state.walletUndecodedMetaCount = 0;
    state.walletUndecodedMetaVersions = new Set();

    try {
      if (wallet.deploymentBackfilledAt) {
        await quickCheck(wallet, horizon, config, store, state, readExecutable);
      } else {
        await backfill(wallet, horizon, config, store, state, readExecutable);
      }
    } catch (err) {
      logger.error({ pubkey: wallet.pubkey, error: String(err) }, 'deployments.scanFailed');
    }

    if (state.walletUndecodedMetaCount > 0) {
      // Because the cursor and watermark move past these operations anyway,
      // the log line is the only trace they leave.
      logger.warn(
        {
          wallet: wallet.pubkey,
          count: state.walletUndecodedMetaCount,
          metaVersions: Array.from(state.walletUndecodedMetaVersions),
        },
        'deployments.undecodedMeta',
      );
    }

    // Cleared whether the scan succeeded or failed: a scan was *attempted*
    // promptly either way, and leaving the request set after a transient
    // Horizon failure would keep forcing short ticks for as long as Horizon
    // stays down.
    if (wallet.indexRequestedAt) {
      await store.wallet.update({ where: { id: wallet.id }, data: { indexRequestedAt: null } });
      logger.debug({ pubkey: wallet.pubkey }, 'deployments.indexRequestFulfilled');
    }

    logger.debug(
      { pubkey: wallet.pubkey, new: state.newContracts - before },
      'deployments.walletDone',
    );
  }

  return {
    highestLedger: state.highestLedger,
    walletsScanned: wallets.length,
    contractsFound: state.newContracts,
  };
}
