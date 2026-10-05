import { logger } from '../logger.js';

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
  /** Oldest captured invocation: counts say nothing about calls before it. */
  countedSince: Date;
  /** True when the contract's rows are at the capture cap, so the total is a lower bound. */
  totalIsFloor: boolean;
}

/** The `ContractInvocation` columns the counts are derived from. */
export interface ActivityInvocation {
  txHash: string;
  createdAt: Date;
}

/**
 * The persistence surface the worker needs — the injectable seam that keeps
 * contract discovery testable without a database. Production passes Prisma;
 * tests pass an in-memory store. Mirrors the `OperationsStore` pattern in
 * `operations.ts`. Calling `contract.findMany()` fresh on every invocation
 * (not once at startup) is what lets a contract the deployment worker just
 * found — from a wallet linked after the indexer started — get its first
 * snapshot on the very next tick, with no restart.
 *
 * Counts come from `ContractInvocation` (#417), not Horizon: Horizon rejects
 * `forAccount(C…)` with HTTP 400, so that path only ever produced zeros.
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
  contractInvocation: {
    findMany: (args: {
      where: { contractId: string };
      select: { txHash: true; createdAt: true };
    }) => Promise<ActivityInvocation[]>;
  };
}

export async function runActivityWorker(
  store: ActivityStore,
  config: { invocationsMaxPerContract?: number } = {},
): Promise<{ snapshotsWritten: number }> {
  const contracts = await store.contract.findMany({
    include: {
      snapshots: {
        orderBy: { capturedAt: 'desc' },
        take: 1,
      },
    },
  });
  // 0 (or unset) means the prune worker keeps every row, so no total is a floor.
  const cap = config.invocationsMaxPerContract ?? 0;
  let snapshotsWritten = 0;

  for (const contract of contracts) {
    const lastSnapshot = contract.snapshots[0];

    // Skip if snapshot is fresh
    if (lastSnapshot) {
      const age = Date.now() - lastSnapshot.capturedAt.getTime();
      if (age < SNAPSHOT_TTL_MS) continue;
    }

    try {
      const rows = await store.contractInvocation.findMany({
        where: { contractId: contract.id },
        select: { txHash: true, createdAt: true },
      });

      // Not captured yet: there is nothing to measure, and a zero row would
      // read as "nobody calls this contract".
      if (rows.length === 0) continue;

      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
      const allTxs = new Set<string>();
      const recentTxs = new Set<string>();
      let lastActivity = rows[0]!.createdAt;
      let countedSince = rows[0]!.createdAt;

      for (const row of rows) {
        allTxs.add(row.txHash);
        if (row.createdAt.getTime() > cutoff24h) recentTxs.add(row.txHash);
        if (row.createdAt > lastActivity) lastActivity = row.createdAt;
        if (row.createdAt < countedSince) countedSince = row.createdAt;
      }

      await store.contractSnapshot.create({
        data: {
          contractId: contract.id,
          txCount24h: recentTxs.size,
          txCountTotal: allTxs.size,
          lastActivity,
          countedSince,
          totalIsFloor: cap > 0 && rows.length >= cap,
        },
      });
      snapshotsWritten++;

      logger.debug(
        { contract: contract.address, txCountTotal: allTxs.size, txCount24h: recentTxs.size },
        'activity.refreshed',
      );
    } catch (error) {
      // Writes nothing: a failed read must not become a zero-count snapshot.
      logger.warn(
        { contract: contract.address, error: error instanceof Error ? error.message : String(error) },
        'activity.storeFailed — no snapshot written',
      );
    }
  }

  return { snapshotsWritten };
}
