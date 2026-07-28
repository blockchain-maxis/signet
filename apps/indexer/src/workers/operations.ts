import type { Horizon } from '@stellar/stellar-sdk';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { sleep } from '../stellar.js';

const RATE_LIMIT_DELAY_MS = 100;
const PER_WALLET_LIMIT = 50;
const MAX_PAGES = 10;

/**
 * For each tracked wallet, pull recent Soroban invocations from Horizon and
 * upsert them into the `Operation` table (idempotent on the Horizon op id).
 * Follows Horizon pagination links until either reaching an operation that has
 * already been persisted or exhausting the max-pages guard.
 * This is what backs the activity list on `/p/{handle}` once the DB is live —
 * the web app reads these rows in preference to the static demo JSON.
 */
export interface OperationsResult {
  opsUpserted: number;
  walletsScanned: number;
}

export async function runOperationsWorker(horizon: Horizon.Server): Promise<OperationsResult> {
  const wallets = await prisma.wallet.findMany();
  let opsUpserted = 0;

  for (const wallet of wallets) {
    let stored = 0;
    let pagesRead = 0;
    try {
      // Find the most recently persisted operation id so we know where to stop.
      const lastOp = await prisma.operation.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const stopAtId = lastOp?.id;

      let page = await horizon
        .operations()
        .forAccount(wallet.pubkey)
        .order('desc')
        .limit(PER_WALLET_LIMIT)
        .call();
      await sleep(RATE_LIMIT_DELAY_MS);

      while (page.records.length > 0 && pagesRead < MAX_PAGES) {
        pagesRead++;
        let hitStop = false;

        for (const op of page.records) {
          if (op.type !== 'invoke_host_function') continue;

          // If we've reached an operation we already persisted, stop scanning
          // this wallet — everything older than this is guaranteed to be in the
          // database already.
          if (stopAtId && op.id === stopAtId) {
            hitStop = true;
            break;
          }

          // Horizon's SDK types don't expose the invoke-host-function fields.
          const r = op as any;

          await prisma.operation.upsert({
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

        // Follow the next (older) page, if any.
        try {
          page = await page.next();
          await sleep(RATE_LIMIT_DELAY_MS);
        } catch {
          break; // No more pages.
        }
      }
    } catch (err) {
      logger.error({ pubkey: wallet.pubkey, error: String(err) }, 'operations.scanFailed');
    }
    opsUpserted += stored;
    logger.debug({ pubkey: wallet.pubkey, stored, pagesRead }, 'operations.walletDone');
  }

  return { opsUpserted, walletsScanned: wallets.length };
}
