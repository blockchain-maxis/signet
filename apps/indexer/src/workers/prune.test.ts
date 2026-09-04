import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPruningWorker, type PruningStore } from './prune.ts';

function createMockPruningStore() {
  const operations: Array<{ id: string; createdAt: Date }> = [];
  const snapshots: Array<{ id: string; capturedAt: Date }> = [];

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
  };

  return { store, operations, snapshots };
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

test('pruning worker skips deletion when retention is 0 (disabled)', async () => {
  const { store, operations, snapshots } = createMockPruningStore();
  const now = new Date('2026-08-31T12:00:00Z');

  operations.push({ id: 'op-old', createdAt: new Date('2026-01-01T12:00:00Z') });
  snapshots.push({ id: 's-old', capturedAt: new Date('2026-01-01T12:00:00Z') });

  const result = await runPruningWorker(
    store,
    { operationsRetentionDays: 0, snapshotsRetentionDays: 0 },
    now,
  );

  assert.equal(result.opsPruned, 0);
  assert.equal(result.snapshotsPruned, 0);
  assert.equal(operations.length, 1);
  assert.equal(snapshots.length, 1);
});
