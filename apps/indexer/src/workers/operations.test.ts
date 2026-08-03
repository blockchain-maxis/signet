import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Horizon } from '@stellar/stellar-sdk';
import { runOperationsWorker, type OperationsStore, type OperationCreate } from './operations.ts';

/**
 * An in-memory `OperationsStore` that upserts keyed on the op id — the same
 * invariant the real Prisma `Operation` table enforces. `rows.size` is the row
 * count the idempotency guarantee is about.
 *
 * `findFirst` mirrors the newest-first ordering the worker asks Prisma for, so
 * the pagination stop cursor behaves the same way it does against a database.
 */
function memoryStore(wallets: Array<{ id: string; pubkey: string }>) {
  const rows = new Map<string, OperationCreate>();
  const store: OperationsStore = {
    wallet: { findMany: async () => wallets },
    operation: {
      findFirst: async ({ where }) => {
        const forWallet = [...rows.values()].filter((r) => r.walletId === where.walletId);
        if (forWallet.length === 0) return null;
        const newest = forWallet.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        return { id: newest.id };
      },
      upsert: async ({ where, update, create }) => {
        const existing = rows.get(where.id);
        if (existing) {
          rows.set(where.id, { ...existing, ...update });
        } else {
          rows.set(where.id, create);
        }
        return undefined;
      },
    },
  };
  return { store, rows };
}

const WALLET = { id: 'w1', pubkey: 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD' };

function invokeOp(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'invoke_host_function',
    transaction_successful: true,
    source_account: WALLET.pubkey,
    created_at: '2026-03-04T12:00:00Z',
    transaction_hash: `hash-${id}`,
    function: 'HostFunctionTypeHostFunctionTypeInvokeContract',
    asset_balance_changes: [],
    ...overrides,
  };
}

/**
 * A Horizon stub serving the given pages in order, newest page first.
 * `calls.pagesFetched` counts how many pages the worker actually fetched — the
 * number the max-pages guard and the stop cursor are about. Horizon signals
 * exhaustion with an empty final page, so the stub does too.
 */
function horizonPaginated(pages: unknown[][]) {
  const calls = { pagesFetched: 0 };

  function pageAt(i: number): unknown {
    calls.pagesFetched++;
    return {
      records: pages[i] ?? [],
      next: async () => pageAt(i + 1),
    };
  }

  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => pageAt(0),
          }),
        }),
      }),
    }),
  } as unknown as Horizon.Server;

  return { horizon, calls };
}

/** Single-page Horizon stub — the shape the non-pagination tests want. */
function horizonReturning(records: unknown[]): Horizon.Server {
  return horizonPaginated([records]).horizon;
}

test('running the worker twice over the same fixture leaves the row count unchanged', async () => {
  const fixture = [invokeOp('op-1'), invokeOp('op-2'), invokeOp('op-3')];
  const horizon = horizonReturning(fixture);
  const { store, rows } = memoryStore([WALLET]);

  const first = await runOperationsWorker(horizon, store);
  assert.equal(rows.size, 3, 'first run stores every operation');
  assert.equal(first.opsUpserted, 3);

  const second = await runOperationsWorker(horizon, store);
  assert.equal(rows.size, 3, 'second run over the same fixture adds no rows');
  assert.equal(second.opsUpserted, 3, 'the second run still upserts each op (idempotently)');
});

test('only invoke_host_function operations are stored', async () => {
  const fixture = [
    invokeOp('op-1'),
    { ...invokeOp('op-2'), type: 'payment' },
    { ...invokeOp('op-3'), type: 'create_account' },
  ];
  const { store, rows } = memoryStore([WALLET]);

  const result = await runOperationsWorker(horizonReturning(fixture), store);

  assert.equal(rows.size, 1, 'non-invocation operations are skipped');
  assert.ok(rows.has('op-1'));
  assert.equal(result.opsUpserted, 1);
});

test('re-running refreshes mutable fields without duplicating the row', async () => {
  const { store, rows } = memoryStore([WALLET]);

  await runOperationsWorker(
    horizonReturning([invokeOp('op-1', { transaction_successful: true })]),
    store,
  );
  assert.equal(rows.get('op-1')?.successful, true);

  // Same op id, now reported as failed — should update in place, not insert.
  await runOperationsWorker(
    horizonReturning([invokeOp('op-1', { transaction_successful: false })]),
    store,
  );
  assert.equal(rows.size, 1, 'the row count is unchanged');
  assert.equal(rows.get('op-1')?.successful, false, 'the existing row is refreshed');
});

// ─── Pagination (#35) ───────────────────────────────────────────────────────

test('follows next links across pages until Horizon is exhausted', async () => {
  const { horizon, calls } = horizonPaginated([
    [invokeOp('op-5'), invokeOp('op-4')],
    [invokeOp('op-3'), invokeOp('op-2')],
    [invokeOp('op-1')],
  ]);
  const { store, rows } = memoryStore([WALLET]);

  const result = await runOperationsWorker(horizon, store);

  assert.equal(rows.size, 5, 'every operation across all three pages is stored');
  assert.equal(result.opsUpserted, 5);
  // 3 pages of data + the empty page that signals the end.
  assert.equal(calls.pagesFetched, 4);
});

test('stops following next links once the stored cursor is reached', async () => {
  const { store, rows } = memoryStore([WALLET]);
  // Seed the store as if a previous run had persisted op-3 — it becomes the
  // newest stored operation, and therefore the stop cursor.
  await runOperationsWorker(horizonReturning([invokeOp('op-3')]), store);
  assert.equal(rows.size, 1);

  const { horizon, calls } = horizonPaginated([
    [invokeOp('op-5', { created_at: '2026-03-04T14:00:00Z' })],
    [invokeOp('op-4', { created_at: '2026-03-04T13:00:00Z' }), invokeOp('op-3')],
    [invokeOp('op-2'), invokeOp('op-1')],
  ]);

  const result = await runOperationsWorker(horizon, store);

  // Page 3 holds op-2/op-1, older than the cursor — it is never fetched.
  assert.equal(calls.pagesFetched, 2, 'the walk stops on the page carrying the cursor');
  assert.ok(!rows.has('op-2') && !rows.has('op-1'), 'pages past the cursor are not read');
  assert.deepEqual([...rows.keys()].sort(), ['op-3', 'op-4', 'op-5']);
  // op-5 and op-4 are new; op-3 is re-upserted so its mutable fields stay fresh.
  assert.equal(result.opsUpserted, 3);
});

test('the max-pages guard bounds a wallet with more history than one tick can read', async () => {
  // 15 pages of two operations each — more than the MAX_PAGES (10) guard allows.
  const pages = Array.from({ length: 15 }, (_, i) => [
    invokeOp(`op-p${i}-a`),
    invokeOp(`op-p${i}-b`),
  ]);
  const { horizon, calls } = horizonPaginated(pages);
  const { store, rows } = memoryStore([WALLET]);

  const result = await runOperationsWorker(horizon, store);

  assert.equal(calls.pagesFetched, 10, 'no more than MAX_PAGES pages are fetched');
  assert.equal(rows.size, 20, 'exactly the operations on those 10 pages are stored');
  assert.equal(result.opsUpserted, 20);
});

test('a wallet with no stored operations reads every available page', async () => {
  const { horizon, calls } = horizonPaginated([[invokeOp('op-2')], [invokeOp('op-1')]]);
  const { store, rows } = memoryStore([WALLET]);

  await runOperationsWorker(horizon, store);

  assert.equal(rows.size, 2, 'with no cursor the walk is not cut short');
  assert.equal(calls.pagesFetched, 3, 'both data pages plus the terminating empty page');
});

test('a Horizon failure on one wallet does not abort the others', async () => {
  const OTHER = { id: 'w2', pubkey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H' };
  const { store, rows } = memoryStore([WALLET, OTHER]);

  let call = 0;
  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => {
              // The first wallet scanned blows up; the second succeeds.
              if (call++ === 0) throw new Error('horizon exploded: status=400');
              return { records: [invokeOp('op-1')], next: async () => ({ records: [] }) };
            },
          }),
        }),
      }),
    }),
  } as unknown as Horizon.Server;

  const result = await runOperationsWorker(horizon, store);

  assert.equal(result.walletsScanned, 2);
  assert.equal(rows.size, 1, "the healthy wallet's operations are still stored");
});
