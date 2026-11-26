import type { Horizon } from '@stellar/stellar-sdk';
import type { Prisma } from '@signet/db';
import { decodeInvokeParameters } from '@signet/visualiser';
import { logger } from '../logger.js';
import { sleep } from '../stellar.js';
import { withRetry } from '../retry.js';
import type { IndexerConfig } from '../config.js';
import { retentionCutoff } from './retention.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'operations.horizon';
const PER_WALLET_LIMIT = 50;
/**
 * Upper bound on Horizon pages walked per wallet per tick, by each of the two
 * walks below. A wallet with more history than this is read over subsequent
 * ticks instead of stalling the whole run on one very busy account.
 */
const MAX_PAGES = 10;

/**
 * For each tracked wallet, pull Soroban invocations from Horizon and upsert
 * them into the `Operation` table (idempotent on the Horizon op id). This is
 * what backs the activity list on `/p/{handle}` once the DB is live — the web
 * app reads these rows in preference to a live Horizon read.
 *
 * Horizon returns newest-first, one page at a time, and a wallet is read in
 * two parts:
 *
 * - The **forward check** starts at the newest operation and follows the
 *   `next` links until it reaches an operation it has already stored, or hits
 *   the `MAX_PAGES` guard. It is what picks up new activity.
 * - The **backward walk** reads the history the forward check cannot reach.
 *   Left to itself the forward check never gets past its first tick's page
 *   cap: from the second tick on it stops on the first page, at the newest
 *   stored row, and whatever is older stays unread. So the walk resumes from
 *   `Wallet.operationsCursor`, `MAX_PAGES` pages a tick, until it meets the
 *   retention cutoff or the end of the wallet's history, and then sets
 *   `Wallet.operationsBackfilledAt`.
 *
 * A wallet whose walk has not started gets the walk alone: it starts at the
 * newest operation, so it reads what the forward check would.
 */
export interface OperationsResult {
  opsUpserted: number;
  walletsScanned: number;
}

/** A tracked wallet, as far as this worker is concerned. */
export interface OperationsWallet {
  id: string;
  pubkey: string;
  /**
   * The Horizon paging_token of the oldest operation the backward walk has
   * read so far — see the schema comment on Wallet.operationsCursor. `null`
   * means the walk has not started (a fresh wallet, or one indexed before the
   * walk existed).
   */
  operationsCursor: string | null;
  /** Set once the backward walk has met the retention cutoff or the end of this wallet's history. */
  operationsBackfilledAt: Date | null;
}

/** Fields written to an `Operation` row on create. */
export interface OperationCreate {
  id: string;
  walletId: string;
  type: string;
  function: string | null;
  decodedFunction?: string | null;
  contractAddress?: string | null;
  sourceAccount: string | null;
  createdAt: Date;
  transactionHash: string | null;
  successful: boolean;
  balanceChanges?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
}

/** Fields refreshed on an existing `Operation` row. */
export interface OperationUpdate {
  successful: boolean;
  balanceChanges?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  decodedFunction?: string;
  contractAddress?: string;
}

/**
 * The persistence surface the worker needs — the injectable seam that makes its
 * idempotency (upsert keyed on the Horizon op id), its pagination stop
 * condition and its backward walk testable without a database. Production
 * passes Prisma; tests pass an in-memory store. Mirrors the `AttestationStore`
 * pattern in `attestation.ts`.
 */
export interface OperationsStore {
  wallet: {
    findMany: () => Promise<OperationsWallet[]>;
    update: (args: {
      where: { id: string };
      data: { operationsCursor?: string | null; operationsBackfilledAt?: Date };
    }) => Promise<unknown>;
  };
  operation: {
    findFirst: (args: {
      where: { walletId: string };
      orderBy: { createdAt: 'desc' };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
    upsert: (args: {
      where: { id: string };
      update: OperationUpdate;
      create: OperationCreate;
    }) => Promise<unknown>;
  };
}

/**
 * The slice of a Horizon `CollectionPage` the pagination loop walks. Declared
 * structurally so the loop stays readable — the SDK's own generics carry a lot
 * of noise this worker never touches.
 */
interface OperationsPage {
  records: Horizon.ServerApi.OperationRecord[];
  next: () => Promise<OperationsPage>;
}

/** What both walks need. The same for every wallet in a run. */
interface ScanContext {
  horizon: Horizon.Server;
  store: OperationsStore;
  /** Operations older than this are outside the retention window. `undefined` keeps everything. */
  cutoff: Date | undefined;
  now: Date;
  /** Waits between two Horizon requests. */
  pause: (ms: number) => Promise<void>;
}

/** What one wallet's scan has done so far, across both walks. */
interface WalletProgress {
  stored: number;
  pagesRead: number;
}

/**
 * Upserts one invocation, keyed on the Horizon op id: creates the row, or
 * refreshes the mutable fields (`successful`, `balanceChanges`) of one that
 * is already there.
 */
async function storeInvocation(
  store: OperationsStore,
  wallet: OperationsWallet,
  op: Horizon.ServerApi.OperationRecord,
): Promise<void> {
  // Horizon's SDK types don't expose the invoke-host-function fields.
  const r = op as any;
  const decoded = decodeInvokeParameters(r.parameters);

  await store.operation.upsert({
    where: { id: op.id },
    update: {
      successful: op.transaction_successful ?? true,
      balanceChanges: r.asset_balance_changes ?? undefined,
      decodedFunction: decoded.fn ?? undefined,
      contractAddress: decoded.contract ?? undefined,
    },
    create: {
      id: op.id,
      walletId: wallet.id,
      type: op.type,
      function: r.function ?? null,
      decodedFunction: decoded.fn ?? null,
      contractAddress: decoded.contract ?? null,
      sourceAccount: op.source_account ?? null,
      createdAt: new Date(op.created_at),
      transactionHash: op.transaction_hash ?? null,
      successful: op.transaction_successful ?? true,
      balanceChanges: r.asset_balance_changes ?? undefined,
    },
  });
}

/**
 * The forward check: read newest-first until an operation that is already
 * stored. This is what picks up a wallet's new activity, and on a quiet wallet
 * it costs one page.
 */
async function forwardCheck(
  wallet: OperationsWallet,
  { horizon, store, cutoff, pause }: ScanContext,
  progress: WalletProgress,
): Promise<void> {
  // The newest operation already persisted for this wallet. Horizon is read
  // newest-first, so reaching this id means everything from here down to
  // where the backward walk has got to is already in the database, and the
  // check can stop.
  const lastOp = await store.operation.findFirst({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const stopAtId = lastOp?.id;

  let page = (await withRetry(
    () =>
      horizon.operations().forAccount(wallet.pubkey).order('desc').limit(PER_WALLET_LIMIT).call(),
    { label: RETRY_LABEL },
  )) as unknown as OperationsPage;
  await pause(RATE_LIMIT_DELAY_MS);

  let pagesRead = 0;
  while (page.records.length > 0 && pagesRead < MAX_PAGES) {
    pagesRead++;
    progress.pagesRead++;
    let hitStop = false;

    for (const op of page.records) {
      // Records are newest-first. Once one falls outside the retention
      // window, all following records do too, so do not fetch or write
      // any more historical operations.
      if (cutoff && new Date(op.created_at) < cutoff) {
        hitStop = true;
        break;
      }

      if (op.type !== 'invoke_host_function') continue;

      // Reaching the stored cursor means every older operation is already
      // persisted, so no further page needs fetching. The current page is
      // still upserted in full — that is what keeps mutable fields
      // (`successful`, `balanceChanges`) fresh on rows we already have.
      if (stopAtId && op.id === stopAtId) hitStop = true;

      await storeInvocation(store, wallet, op);
      progress.stored++;
    }

    if (hitStop) break;
    if (pagesRead >= MAX_PAGES) {
      logger.debug({ pubkey: wallet.pubkey, pagesRead }, 'operations.maxPagesReached');
      break;
    }

    // Follow the next (older) page. Horizon signals exhaustion with an empty
    // page, but a missing `next` link throws — treat both as "done".
    try {
      page = await withRetry(() => page.next(), { label: RETRY_LABEL });
    } catch {
      break;
    }
    await pause(RATE_LIMIT_DELAY_MS);
  }
}

/**
 * The backward walk: resume exactly where `operationsCursor` left off
 * (Horizon's own `.cursor()` — omitted on the first tick, which starts at the
 * newest operation) and persist how far it got. Bounded to `MAX_PAGES` pages
 * so one deep history can't stall the whole tick; the next tick picks up from
 * the cursor this one saved, rather than re-walking from the top.
 *
 * It ends at the first operation older than the retention cutoff, or at the
 * end of the wallet's history, and then sets `operationsBackfilledAt`.
 */
async function backfill(
  wallet: OperationsWallet,
  { horizon, store, cutoff, now, pause }: ScanContext,
  progress: WalletProgress,
): Promise<void> {
  let page = (await withRetry(
    () => {
      const query = horizon
        .operations()
        .forAccount(wallet.pubkey)
        .order('desc')
        .limit(PER_WALLET_LIMIT);
      return (wallet.operationsCursor ? query.cursor(wallet.operationsCursor) : query).call();
    },
    { label: RETRY_LABEL },
  )) as unknown as OperationsPage;
  await pause(RATE_LIMIT_DELAY_MS);

  let cursor = wallet.operationsCursor;
  let savedCursor = cursor;
  let pagesRead = 0;
  // Nothing further back is left to read: the walk met the retention cutoff,
  // or Horizon returned an empty page.
  let finished = false;

  while (true) {
    if (page.records.length === 0) {
      finished = true;
      break;
    }
    pagesRead++;
    progress.pagesRead++;

    for (const op of page.records) {
      // Records are newest-first, so the first one outside the retention
      // window ends the walk: everything after it is older still. The cursor
      // stays on the last record inside the window.
      if (cutoff && new Date(op.created_at) < cutoff) {
        finished = true;
        break;
      }

      if (op.type === 'invoke_host_function') {
        await storeInvocation(store, wallet, op);
        progress.stored++;
      }

      // Every record moves the cursor, not only the invocations: it is a
      // position in the wallet's whole operation history.
      if (op.paging_token) cursor = op.paging_token;
    }

    // Persisted per page rather than once after the loop: a crash partway
    // through a tick would otherwise discard up to MAX_PAGES pages of walking
    // and redo them next time.
    if (cursor !== savedCursor) {
      await store.wallet.update({
        where: { id: wallet.id },
        data: { operationsCursor: cursor },
      });
      savedCursor = cursor;
    }

    if (finished) break;
    if (pagesRead >= MAX_PAGES) {
      logger.debug({ pubkey: wallet.pubkey, pagesRead }, 'operations.backfillPaused');
      break;
    }

    try {
      page = await withRetry(() => page.next(), { label: RETRY_LABEL });
    } catch (err) {
      // A request that failed is not the end of the history. Stop here without
      // marking the walk finished: the cursor is saved, so the next tick asks
      // for this page again. If the history really has ended, that request
      // comes back empty and the walk finishes then.
      logger.warn({ pubkey: wallet.pubkey, error: String(err) }, 'operations.backfillPageFailed');
      break;
    }
    await pause(RATE_LIMIT_DELAY_MS);
  }

  // The cursor is already saved by the per-page write above; the only thing
  // left to record is that the walk is over.
  if (finished) {
    await store.wallet.update({
      where: { id: wallet.id },
      data: { operationsBackfilledAt: now },
    });
    logger.debug({ pubkey: wallet.pubkey, cursor }, 'operations.backfilled');
  }
}

export async function runOperationsWorker(
  horizon: Horizon.Server,
  store: OperationsStore,
  config: Pick<IndexerConfig, 'operationsRetentionDays'> = { operationsRetentionDays: 0 },
  now: Date = new Date(),
  /** Waits between two Horizon requests. Tests pass one that does not wait. */
  pause: (ms: number) => Promise<void> = sleep,
): Promise<OperationsResult> {
  const wallets = await store.wallet.findMany();
  const scan: ScanContext = {
    horizon,
    store,
    cutoff: retentionCutoff(config.operationsRetentionDays, now),
    now,
    pause,
  };
  let opsUpserted = 0;

  for (const wallet of wallets) {
    const progress: WalletProgress = { stored: 0, pagesRead: 0 };
    try {
      // A wallet whose backward walk has not started gets the walk alone: it
      // starts at the newest operation, so a forward check before it would
      // only read the same pages twice.
      const walkStarted = Boolean(wallet.operationsCursor || wallet.operationsBackfilledAt);
      if (walkStarted) await forwardCheck(wallet, scan, progress);
      if (!wallet.operationsBackfilledAt) await backfill(wallet, scan, progress);
    } catch (err) {
      logger.error({ pubkey: wallet.pubkey, error: String(err) }, 'operations.scanFailed');
    }
    opsUpserted += progress.stored;
    logger.debug(
      { pubkey: wallet.pubkey, stored: progress.stored, pagesRead: progress.pagesRead },
      'operations.walletDone',
    );
  }

  return { opsUpserted, walletsScanned: wallets.length };
}
