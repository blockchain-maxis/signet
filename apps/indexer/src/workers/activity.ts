import type { Horizon } from '@stellar/stellar-sdk';
import { logger } from '../logger.js';
import { sleep } from '../stellar.js';
import { withRetry } from '../retry.js';

const RATE_LIMIT_DELAY_MS = 100;
const RETRY_LABEL = 'activity.horizon';
const SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** A tracked contract, as far as this worker is concerned. */
export interface ActivityContract {
  id: string;
  address: string;
  /** Most recent snapshot first; only the newest one is read. */
  snapshots: Array<{ capturedAt: Date }>;
}

/** Fields written to a `ContractSnapshot` row on create. */
export interface ContractSnapshotCreate {
  contractId: string;
  txCount24h: number;
  txCountTotal: number;
  lastActivity: Date | null;
}

/**
 * The persistence surface the worker needs — the injectable seam that keeps
 * contract discovery testable without a database. Production passes Prisma;
 * tests pass an in-memory store. Mirrors the `OperationsStore` pattern in
 * `operations.ts`. Calling `contract.findMany()` fresh on every invocation
 * (not once at startup) is what lets a contract the deployment worker just
 * found — from a wallet linked after the indexer started — get its first
 * snapshot on the very next tick, with no restart.
 */
export interface ActivityStore {
  contract: {
    findMany: (args: {
      include: { snapshots: { orderBy: { capturedAt: 'desc' }; take: 1 } };
    }) => Promise<ActivityContract[]>;
  };
  contractSnapshot: {
    create: (args: { data: ContractSnapshotCreate }) => Promise<unknown>;
  };
}

export async function runActivityWorker(
  horizon: Horizon.Server,
  store: ActivityStore,
): Promise<{ snapshotsWritten: number }> {
  const contracts = await store.contract.findMany({
    include: {
      snapshots: {
        orderBy: { capturedAt: 'desc' },
        take: 1,
      },
    },
  });
  let snapshotsWritten = 0;

  for (const contract of contracts) {
    const lastSnapshot = contract.snapshots[0];

    // Skip if snapshot is fresh
    if (lastSnapshot) {
      const age = Date.now() - lastSnapshot.capturedAt.getTime();
      if (age < SNAPSHOT_TTL_MS) continue;
    }

    let txCountTotal = 0;
    let txCount24h = 0;
    let lastActivity: Date | null = null;
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    try {
      // Horizon supports querying transactions for Soroban contract accounts
      const txs = await withRetry(
        () =>
          horizon
            .transactions()
            .forAccount(contract.address)
            .order('desc')
            .limit(200)
            .call(),
        { label: RETRY_LABEL },
      );

      await sleep(RATE_LIMIT_DELAY_MS);

      for (const tx of txs.records) {
        txCountTotal++;
        const txDate = new Date(tx.created_at);
        if (txDate > cutoff24h) txCount24h++;
        if (!lastActivity || txDate > lastActivity) lastActivity = txDate;
      }
    } catch {
      // Contract may not have any indexed transactions; set 0 counts
      logger.warn({ contract: contract.address }, 'activity.queryFailed — using 0 counts');
    }

    await store.contractSnapshot.create({
      data: {
        contractId:   contract.id,
        txCount24h,
        txCountTotal,
        lastActivity,
      },
    });
    snapshotsWritten++;

    logger.debug(
      { contract: contract.address, txCountTotal, txCount24h },
      'activity.refreshed',
    );
  }

  return { snapshotsWritten };
}
