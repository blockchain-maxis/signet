import type { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';
import { sleep } from '../stellar.js';
import { withRetry } from '../retry.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'operations.horizon';
const PER_WALLET_LIMIT = 50;
/**
 * Upper bound on Horizon pages walked per wallet per tick. A wallet with more
 * unseen activity than this catches up over subsequent ticks instead of
 * stalling the whole run on one very busy account.
 */
const MAX_PAGES = 10;

/**
 * For each tracked wallet, pull recent Soroban invocations from Horizon and
 * upsert them into the `Operation` table (idempotent on the Horizon op id).
 * Horizon returns newest-first, one page at a time, so the worker follows the
 * `next` links until it reaches an operation it has already stored (everything
 * older is by definition already persisted) or hits the `MAX_PAGES` guard.
 * This is what backs the activity list on `/p/{handle}` once the DB is live —
 * the web app reads these rows in preference to the static demo JSON.
 */
export interface OperationsResult {
  opsUpserted: number;
  walletsScanned: number;
}

/** A tracked wallet, as far as this worker is concerned. */
export interface OperationsWallet {
  id: string;
  pubkey: string;
}

/** Fields written to an `Operation` row on create. */
export interface OperationCreate {
  id: string;
  walletId: string;
  type: string;
  function: string | null;
  sourceAccount: string | null;
  createdAt: Date;
  transactionHash: string | null;
  successful: boolean;
  balanceChanges?: unknown;
}

/** Fields refreshed on an existing `Operation` row. */
export interface OperationUpdate {
  successful: boolean;
  balanceChanges?: unknown;
}

/**
 * The persistence surface the worker needs — the injectable seam that makes its
 * idempotency (upsert keyed on the Horizon op id) and its pagination stop
 * condition testable without a database. Production passes Prisma; tests pass
 * an in-memory store. Mirrors the `AttestationStore` pattern in
 * `attestation.ts`.
 */
export interface OperationsStore {
  wallet: { findMany: () => Promise<OperationsWallet[]> };
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

export async function runOperationsWorker(
  horizon: Horizon.Server,
  store: OperationsStore,
): Promise<OperationsResult> {
  const wallets = await store.wallet.findMany();
  let opsUpserted = 0;

  for (const wallet of wallets) {
    let stored = 0;
    let pagesRead = 0;
    try {
      // The newest operation already persisted for this wallet. Horizon is read
      // newest-first, so reaching this id means the rest of the history is
      // already in the database and the walk can stop.
      const lastOp = await store.operation.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const stopAtId = lastOp?.id;

      let page = (await withRetry(
        () =>
          horizon
            .operations()
            .forAccount(wallet.pubkey)
            .order('desc')
            .limit(PER_WALLET_LIMIT)
            .call(),
        { label: RETRY_LABEL },
      )) as unknown as OperationsPage;
      await sleep(RATE_LIMIT_DELAY_MS);

      while (page.records.length > 0 && pagesRead < MAX_PAGES) {
        pagesRead++;
        let hitStop = false;

        for (const op of page.records) {
          if (op.type !== 'invoke_host_function') continue;

          // Reaching the stored cursor means every older operation is already
          // persisted, so no further page needs fetching. The current page is
          // still upserted in full — that is what keeps mutable fields
          // (`successful`, `balanceChanges`) fresh on rows we already have.
          if (stopAtId && op.id === stopAtId) hitStop = true;

          // Horizon's SDK types don't expose the invoke-host-function fields.
          const r = op as any;

          await store.operation.upsert({
            where: { id: op.id },
            update: {
              successful: op.transaction_successful ?? true,
              balanceChanges: r.asset_balance_changes ?? undefined,
            },
            create: {
              id: op.id,
              walletId: wallet.id,
              type: op.type,
              function: r.function ?? null,
              sourceAccount: op.source_account ?? null,
              createdAt: new Date(op.created_at),
              transactionHash: op.transaction_hash ?? null,
              successful: op.transaction_successful ?? true,
              balanceChanges: r.asset_balance_changes ?? undefined,
            },
          });
          stored++;
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
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    } catch (err) {
      logger.error({ pubkey: wallet.pubkey, error: String(err) }, 'operations.scanFailed');
    }
    opsUpserted += stored;
    logger.debug({ pubkey: wallet.pubkey, stored, pagesRead }, 'operations.walletDone');
  }

  return { opsUpserted, walletsScanned: wallets.length };
}
