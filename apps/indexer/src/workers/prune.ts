import { logger } from '../logger.js';
import type { IndexerConfig } from '../config.js';

export interface PruningStore {
  operation: {
    deleteMany: (args: {
      where: {
        createdAt: { lt: Date };
      };
    }) => Promise<{ count: number }>;
  };
  contractSnapshot: {
    deleteMany: (args: {
      where: {
        capturedAt: { lt: Date };
      };
    }) => Promise<{ count: number }>;
  };
}

export interface PruningResult {
  opsPruned: number;
  snapshotsPruned: number;
}

/**
 * Prune historical records older than configured retention windows.
 *
 * Policies:
 *  - Operations: delete `Operation` records with `createdAt` older than
 *    `operationsRetentionDays` (default: 90 days). 0 disables pruning.
 *  - ContractSnapshots: delete `ContractSnapshot` records with `capturedAt` older than
 *    `snapshotsRetentionDays` (default: 30 days). 0 disables pruning.
 */
export async function runPruningWorker(
  store: PruningStore,
  config: Pick<IndexerConfig, 'operationsRetentionDays' | 'snapshotsRetentionDays'>,
  now: Date = new Date(),
): Promise<PruningResult> {
  let opsPruned = 0;
  let snapshotsPruned = 0;

  if (config.operationsRetentionDays > 0) {
    const cutoff = new Date(
      now.getTime() - config.operationsRetentionDays * 24 * 60 * 60 * 1000,
    );
    try {
      const result = await store.operation.deleteMany({
        where: {
          createdAt: { lt: cutoff },
        },
      });
      opsPruned = result.count;
      logger.debug({ opsPruned, cutoff: cutoff.toISOString() }, 'prune.operations');
    } catch (err) {
      logger.error({ error: String(err) }, 'prune.operations_failed');
    }
  }

  if (config.snapshotsRetentionDays > 0) {
    const cutoff = new Date(
      now.getTime() - config.snapshotsRetentionDays * 24 * 60 * 60 * 1000,
    );
    try {
      const result = await store.contractSnapshot.deleteMany({
        where: {
          capturedAt: { lt: cutoff },
        },
      });
      snapshotsPruned = result.count;
      logger.debug({ snapshotsPruned, cutoff: cutoff.toISOString() }, 'prune.snapshots');
    } catch (err) {
      logger.error({ error: String(err) }, 'prune.snapshots_failed');
    }
  }

  if (opsPruned > 0 || snapshotsPruned > 0) {
    logger.info({ opsPruned, snapshotsPruned }, 'prune.summary');
  }

  return { opsPruned, snapshotsPruned };
}
