import type { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';
import { sleep } from '../stellar.js';
import { withRetry } from '../retry.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'operations.horizon';
const PER_WALLET_LIMIT = 50;

/**
 * For each tracked wallet, pull recent Soroban invocations from Horizon and
 * upsert them into the `Operation` table (idempotent on the Horizon op id).
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
 * idempotency (upsert keyed on the Horizon op id) testable without a database.
 * Production passes Prisma; tests pass an in-memory store. Mirrors the
 * `AttestationStore` pattern in `attestation.ts`.
 */
export interface OperationsStore {
  wallet: { findMany: () => Promise<OperationsWallet[]> };
  operation: {
    upsert: (args: {
      where: { id: string };
      update: OperationUpdate;
      create: OperationCreate;
    }) => Promise<unknown>;
  };
}

export async function runOperationsWorker(
  horizon: Horizon.Server,
  store: OperationsStore,
): Promise<OperationsResult> {
  const wallets = await store.wallet.findMany();
  let opsUpserted = 0;

  for (const wallet of wallets) {
    let stored = 0;
    try {
      const ops = await withRetry(
        () =>
          horizon
            .operations()
            .forAccount(wallet.pubkey)
            .order('desc')
            .limit(PER_WALLET_LIMIT)
            .call(),
        { label: RETRY_LABEL },
      );
      await sleep(RATE_LIMIT_DELAY_MS);

      for (const op of ops.records) {
        if (op.type !== 'invoke_host_function') continue;
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
    } catch (err) {
      logger.error({ pubkey: wallet.pubkey, error: String(err) }, 'operations.scanFailed');
    }
    opsUpserted += stored;
    logger.debug({ pubkey: wallet.pubkey, stored }, 'operations.walletDone');
  }

  return { opsUpserted, walletsScanned: wallets.length };
}
