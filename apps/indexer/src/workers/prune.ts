import { logger } from '../logger.js';
import type { IndexerConfig } from '../config.js';
import { retentionCutoff } from './retention.js';

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
  contract?: {
    findMany: (args?: {
      select: { id: true };
    }) => Promise<Array<{ id: string }>>;
  };
  contractInvocation?: {
    findMany: (args: {
      where: { contractId: string };
      orderBy: { createdAt: 'desc' };
      skip: number;
      select: { id: true };
    }) => Promise<Array<{ id: string }>>;
    deleteMany: (args: {
      where: {
        id: { in: string[] };
      };
    }) => Promise<{ count: number }>;
  };
}

export interface PruningResult {
  opsPruned: number;
  snapshotsPruned: number;
  invocationsPruned: number;
}

/**
 * Prune historical records older than configured retention windows or exceeding per-contract caps.
 *
 * Policies:
 *  - Operations: delete `Operation` records with `createdAt` older than
 *    `operationsRetentionDays` (default: 90 days). 0 disables pruning.
 *  - ContractSnapshots: delete `ContractSnapshot` records with `capturedAt` older than
 *    `snapshotsRetentionDays` (default: 30 days). 0 disables pruning.
 *  - ContractInvocations: keep at most `invocationsMaxPerContract` rows per contract
 *    (default: 1000). 0 disables pruning.
 */
export async function runPruningWorker(
  store: PruningStore,
  config: Pick<IndexerConfig, 'operationsRetentionDays' | 'snapshotsRetentionDays'> & {
    invocationsMaxPerContract?: number;
  },
  now: Date = new Date(),
): Promise<PruningResult> {
  let opsPruned = 0;
  let snapshotsPruned = 0;
  let invocationsPruned = 0;

  const operationsCutoff = retentionCutoff(config.operationsRetentionDays, now);
  if (operationsCutoff) {
    try {
      const result = await store.operation.deleteMany({
        where: {
          createdAt: { lt: operationsCutoff },
        },
      });
      opsPruned = result.count;
      logger.debug({ opsPruned, cutoff: operationsCutoff.toISOString() }, 'prune.operations');
    } catch (err) {
      logger.error({ error: String(err) }, 'prune.operations_failed');
    }
  }

  const snapshotsCutoff = retentionCutoff(config.snapshotsRetentionDays, now);
  if (snapshotsCutoff) {
    try {
      const result = await store.contractSnapshot.deleteMany({
        where: {
          capturedAt: { lt: snapshotsCutoff },
        },
      });
      snapshotsPruned = result.count;
      logger.debug({ snapshotsPruned, cutoff: snapshotsCutoff.toISOString() }, 'prune.snapshots');
    } catch (err) {
      logger.error({ error: String(err) }, 'prune.snapshots_failed');
    }
  }

  const maxInvocations = config.invocationsMaxPerContract ?? 0;
  if (maxInvocations > 0 && store.contract && store.contractInvocation) {
    try {
      const contracts = await store.contract.findMany({ select: { id: true } });
      for (const contract of contracts) {
        const excess = await store.contractInvocation.findMany({
          where: { contractId: contract.id },
          orderBy: { createdAt: 'desc' },
          skip: maxInvocations,
          select: { id: true },
        });
        if (excess.length > 0) {
          const ids = excess.map((r) => r.id);
          const result = await store.contractInvocation.deleteMany({
            where: { id: { in: ids } },
          });
          invocationsPruned += result.count;
          logger.debug(
            { contractId: contract.id, pruned: result.count, cap: maxInvocations },
            'prune.invocations',
          );
        }
      }
    } catch (err) {
      logger.error({ error: String(err) }, 'prune.invocations_failed');
    }
  }

  if (opsPruned > 0 || snapshotsPruned > 0 || invocationsPruned > 0) {
    logger.info({ opsPruned, snapshotsPruned, invocationsPruned }, 'prune.summary');
  }

  return { opsPruned, snapshotsPruned, invocationsPruned };
}
