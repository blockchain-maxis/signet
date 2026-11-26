import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBackfill, type BackfillStore } from './backfill-operations.ts';

const INVOKE_PARAMETERS = [
  { type: 'Address', value: 'AAAAEgAAAAH4oodbFBaefih5JVDOHOcj/rPQqTNF2uc5cYzP8paqaw==' },
  { type: 'Sym', value: 'AAAADwAAAAx3cml0ZV9wcmljZXM=' },
];

/** An in-memory store that applies the backfill's `where`, order and `take`. */
function fakeStore(ids: string[]) {
  const rows = new Map(
    ids.map((id) => [
      id,
      { id, decodedFunction: null as string | null, contractAddress: null as string | null },
    ]),
  );
  let queries = 0;
  const store: BackfillStore = {
    operation: {
      findMany: async ({ where, take }) => {
        queries++;
        if (queries > 100) throw new Error('backfill is looping');
        return [...rows.values()]
          .filter((r) => r.decodedFunction === null)
          .filter((r) => !where.id || r.id < where.id.lt)
          .sort((a, b) => (a.id < b.id ? 1 : -1))
          .slice(0, take)
          .map((r) => ({ id: r.id }));
      },
      update: async ({ where, data }) => {
        Object.assign(rows.get(where.id)!, data);
        return rows.get(where.id);
      },
    },
  };
  return { store, rows, queries: () => queries };
}

test('backfill stops when every Horizon fetch fails, leaving the rows null', async () => {
  const { store, rows, queries } = fakeStore(['1', '2', '3', '4', '5']);
  const result = await runBackfill({
    store,
    batchSize: 2,
    delayMs: 0,
    fetchParameters: async () => {
      throw new Error('Horizon operation fetch failed: 404 Not Found');
    },
  });
  assert.deepEqual(result, { totalProcessed: 5, totalUpdated: 0, totalFailed: 5 });
  // Three batches of rows plus the empty one that ends the walk.
  assert.equal(queries(), 4);
  for (const row of rows.values()) assert.equal(row.decodedFunction, null);
});

test('backfill writes the decoded function and contract, and never a placeholder', async () => {
  const { store, rows } = fakeStore(['10', '11', '12']);
  const result = await runBackfill({
    store,
    batchSize: 2,
    delayMs: 0,
    // 11 is a CreateContract record: nothing to decode.
    fetchParameters: async (id) =>
      id === '11'
        ? [{ type: 'Vec', value: 'AAAAEAAAAAEAAAABAAAADgAAAANFVEgA' }]
        : INVOKE_PARAMETERS,
  });
  assert.deepEqual(result, { totalProcessed: 3, totalUpdated: 2, totalFailed: 0 });
  assert.deepEqual(rows.get('10'), {
    id: '10',
    decodedFunction: 'write_prices',
    contractAddress: 'CD4KFB23CQLJ47RIPESVBTQ444R75M6QVEZULWXHHFYYZT7SS2VGXOPW',
  });
  assert.equal(rows.get('11')!.decodedFunction, null);
  assert.equal(rows.get('12')!.decodedFunction, 'write_prices');
});
