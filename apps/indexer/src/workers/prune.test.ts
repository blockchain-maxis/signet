import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPruningWorker, type PruningStore } from './prune.ts';

function createMockPruningStore() {
  const operations: Array<{ id: string; createdAt: Date }> = [];
  const snapshots: Array<{ id: string; capturedAt: Date }> = [];
  const contracts: Array<{ id: string }> = [];
  const invocations: Array<{ id: string; contractId: string; createdAt: Date }> = [];

  const store: PruningStore = {
    operation: {
      deleteMany: async ({ where }) => {
        const initialCount = operations.length;
        const remaining = operations.filter((op) => !(op.createdAt < where.createdAt.lt));
        const deletedCount = initialCount - remaining.length;
        operations.length = 0;
        operations.push(...remaining);
        return { count: deletedCount };
      },
    },
    contractSnapshot: {
      deleteMany: async ({ where }) => {
        const initialCount = snapshots.length;
        const remaining = snapshots.filter((s) => !(s.capturedAt < where.capturedAt.lt));
        const deletedCount = initialCount - remaining.length;
        snapshots.length = 0;
        snapshots.push(...remaining);
        return { count: deletedCount };
      },
    },
    contract: {
      findMany: async () => contracts,
    },
    contractInvocation: {
      findMany: async ({ where, skip = 0 }) => {
        const matching = invocations
          .filter((inv) => inv.contractId === where.contractId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matching.slice(skip).map((inv) => ({ id: inv.id }));
      },
      deleteMany: async ({ where }) => {
        const idsToDelete = new Set(where.id.in);
        const initialCount = invocations.length;
        const remaining = invocations.filter((inv) => !idsToDelete.has(inv.id));
        const deletedCount = initialCount - remaining.length;
        invocations.length = 0;
        invocations.push(...remaining);
        return { count: deletedCount };
      },
    },
  };

  return { store, operations, snapshots, contracts, invocations };
}

test('pruning worker deletes operations older than retention days', async () => {
  const { store, operations } = createMockPruningStore();
  const now = new Date('2026-08-31T12:00:00Z');

  // 100 days old (should be pruned under 90-day retention)
  operations.push({ id: 'op-old', createdAt: new Date('2026-05-20T12:00:00Z') });
  // 10 days old (should be retained)
  operations.push({ id: 'op-recent', createdAt: new Date('2026-08-21T12:00:00Z') });

  const result = await runPruningWorker(
    store,
    { operationsRetentionDays: 90, snapshotsRetentionDays: 0 },
    now,
  );

  assert.equal(result.opsPruned, 1);
  assert.equal(operations.length, 1);
  assert.equal(operations[0]?.id, 'op-recent');
});

test('pruning worker deletes snapshots older than retention days', async () => {
  const { store, snapshots } = createMockPruningStore();
  const now = new Date('2026-08-31T12:00:00Z');

  // 45 days old (should be pruned under 30-day retention)
  snapshots.push({ id: 's-old', capturedAt: new Date('2026-07-15T12:00:00Z') });
  // 5 days old (should be retained)
  snapshots.push({ id: 's-recent', capturedAt: new Date('2026-08-26T12:00:00Z') });

  const result = await runPruningWorker(
    store,
    { operationsRetentionDays: 0, snapshotsRetentionDays: 30 },
    now,
  );

  assert.equal(result.snapshotsPruned, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.id, 's-recent');
});

test('pruning worker prunes contract invocations exceeding per-contract cap', async () => {
  const { store, contracts, invocations } = createMockPruningStore();
  contracts.push({ id: 'c-1' });

  // Add 4 invocations for contract c-1
  invocations.push({ id: 'inv-1', contractId: 'c-1', createdAt: new Date('2026-08-01') });
  invocations.push({ id: 'inv-2', contractId: 'c-1', createdAt: new Date('2026-08-02') });
  invocations.push({ id: 'inv-3', contractId: 'c-1', createdAt: new Date('2026-08-03') });
  invocations.push({ id: 'inv-4', contractId: 'c-1', createdAt: new Date('2026-08-04') });

  const result = await runPruningWorker(
    store,
    { operationsRetentionDays: 0, snapshotsRetentionDays: 0, invocationsMaxPerContract: 2 },
  );

  assert.equal(result.invocationsPruned, 2);
  assert.equal(invocations.length, 2);
  // The newest 2 (inv-4, inv-3) should be retained
  assert.deepEqual(invocations.map((i) => i.id), ['inv-3', 'inv-4']);
});

test('pruning worker skips deletion when retention is 0 (disabled)', async () => {
  const { store, operations, snapshots, contracts, invocations } = createMockPruningStore();
  const now = new Date('2026-08-31T12:00:00Z');

  contracts.push({ id: 'c-1' });
  operations.push({ id: 'op-old', createdAt: new Date('2026-01-01T12:00:00Z') });
  snapshots.push({ id: 's-old', capturedAt: new Date('2026-01-01T12:00:00Z') });
  invocations.push({ id: 'inv-1', contractId: 'c-1', createdAt: new Date('2026-01-01') });

  const result = await runPruningWorker(
    store,
    { operationsRetentionDays: 0, snapshotsRetentionDays: 0, invocationsMaxPerContract: 0 },
    now,
  );

  assert.equal(result.opsPruned, 0);
  assert.equal(result.snapshotsPruned, 0);
  assert.equal(result.invocationsPruned, 0);
  assert.equal(operations.length, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(invocations.length, 1);
});
