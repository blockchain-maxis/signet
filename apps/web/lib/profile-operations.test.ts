import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProfileOperationsView, PROFILE_OPERATIONS_PAGE_SIZE } from './profile-operations.ts';
import { computeStats, getProfileStats, type Operation } from './profiles.ts';

function op(i: number): Operation {
  return {
    id: String(i),
    type: 'invoke_host_function',
    function: 'claim',
    created_at: new Date(Date.UTC(2026, 2, 20, 12, 0, 0) - i * 60_000).toISOString(),
    transaction_successful: true,
  };
}

test('a database record of 150 operations is complete and reports the real total', async () => {
  const rows = Array.from({ length: PROFILE_OPERATIONS_PAGE_SIZE }, (_, i) => op(i));
  const view = await getProfileOperationsView('alice', {
    getPagedOperations: async (handle, offset, limit) => {
      assert.equal(handle, 'alice');
      assert.equal(offset, 0);
      assert.equal(limit, PROFILE_OPERATIONS_PAGE_SIZE);
      // The page is the first 25 rows; the total is the database's own count.
      return { data: rows, total: 150 };
    },
    getOperationsResult: async () => {
      throw new Error('the database path must not fall back to the capped read');
    },
  });

  assert.deepEqual(view, {
    operations: rows,
    statsOperations: rows,
    total: 150,
    truncated: false,
    cap: null,
    source: 'database',
  });
});

test('a database record with no operations is complete and totals zero', async () => {
  const view = await getProfileOperationsView('alice', {
    getPagedOperations: async () => ({ data: [], total: 0 }),
    getOperationsResult: async () => {
      throw new Error('the database path must not fall back to the capped read');
    },
  });

  assert.deepEqual(view, {
    operations: [],
    statsOperations: [],
    total: 0,
    truncated: false,
    cap: null,
    source: 'database',
  });
});

test('the Horizon fallback keeps its real cap and reports the record as partial', async () => {
  const capped = Array.from({ length: 100 }, (_, i) => op(i));
  const view = await getProfileOperationsView('alice', {
    getPagedOperations: async () => null,
    getOperationsResult: async () => ({
      operations: capped,
      source: 'horizon',
      truncated: true,
      cap: 100,
    }),
  });

  assert.equal(view.operations.length, PROFILE_OPERATIONS_PAGE_SIZE);
  assert.equal(view.statsOperations, capped);
  assert.equal(view.total, 100);
  assert.equal(view.truncated, true);
  assert.equal(view.cap, 100);
  assert.equal(view.source, 'horizon');
});

test('an uncapped Horizon record keeps every operation for stats, not just the page', async () => {
  // No database, and Horizon returned a complete (uncapped) history. The page
  // renders the first 25 rows, so stats computed from `operations` would count
  // a 25-row sample as the account's exact totals (#899).
  const all = Array.from({ length: 60 }, (_, i) => ({
    ...op(i),
    function: `fn_${i % 20}`,
  }));
  const view = await getProfileOperationsView('alice', {
    getPagedOperations: async () => null,
    getOperationsResult: async () => ({
      operations: all,
      source: 'horizon',
      truncated: false,
      cap: 100,
    }),
  });

  assert.equal(view.operations.length, PROFILE_OPERATIONS_PAGE_SIZE);
  assert.equal(view.truncated, false);
  assert.equal(view.statsOperations.length, 60);
  assert.deepEqual(computeStats(view.statsOperations), computeStats(all));
  assert.notDeepEqual(computeStats(view.statsOperations), computeStats(view.operations));

  // The stats the profile page asks for cover all 60 invocations, while the
  // uncapped record still lets the page present them without a lower-bound "+".
  const stats = await getProfileStats('alice', view.statsOperations);
  assert.equal(stats.invocations, 60);
  assert.equal(stats.uniqueFunctions, 20);
  assert.equal(stats.exact, false);
});
