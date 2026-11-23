import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, scValToNative, xdr, type Horizon } from '@stellar/stellar-sdk';
import {
  runOperationsWorker,
  type OperationsStore,
  type OperationsWallet,
  type OperationCreate,
} from './operations.ts';
import { runPruningWorker, type PruningStore } from './prune.ts';
import { logger } from '../logger.ts';
import { loadFixtureEnvelope, replayHorizon, type HorizonOperationsPage } from '@signet/fixtures';
import { createHorizonServer } from '../stellar.ts';

/**
 * An in-memory `OperationsStore` that upserts keyed on the op id — the same
 * invariant the real Prisma `Operation` table enforces. `rows.size` is the row
 * count the idempotency guarantee is about.
 *
 * `findFirst` mirrors the newest-first ordering the worker asks Prisma for, so
 * the pagination stop cursor behaves the same way it does against a database.
 *
 * Wallets keep the backward walk's state between runs, as the `Wallet` table
 * does: `wallets` is what a later `findMany` returns, and `cursorWrites` is
 * every cursor the worker saved, in order.
 */
function memoryStore(
  seed: Array<Pick<OperationsWallet, 'id' | 'pubkey'> & Partial<OperationsWallet>>,
) {
  const rows = new Map<string, OperationCreate>();
  const wallets: OperationsWallet[] = seed.map((w) => ({
    operationsCursor: null,
    operationsBackfilledAt: null,
    ...w,
  }));
  const cursorWrites: Array<string | null> = [];
  const store: OperationsStore = {
    wallet: {
      findMany: async () => wallets.map((w) => ({ ...w })),
      update: async ({ where, data }) => {
        if (data.operationsCursor !== undefined) cursorWrites.push(data.operationsCursor);
        const wallet = wallets.find((w) => w.id === where.id);
        if (wallet) Object.assign(wallet, data);
        return undefined;
      },
    },
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
  return { store, rows, wallets, cursorWrites };
}

const WALLET = { id: 'w1', pubkey: 'GBNTPIH54YJW4SFUIF2L7PBARVQZVSRKVE72OKN5IZC2CXMAEQI3VWCA' };

function invokeOp(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    // Horizon gives an operation the same value for both.
    paging_token: id,
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

test('retention stops an inactive wallet at its first old operation without writing it', async () => {
  const now = new Date('2026-08-31T12:00:00Z');
  const { horizon, calls } = horizonPaginated([
    [invokeOp('op-old', { created_at: '2026-05-03T12:00:00Z' })],
    [invokeOp('op-older', { created_at: '2026-05-02T12:00:00Z' })],
  ]);
  const { store, rows } = memoryStore([WALLET]);

  const result = await runOperationsWorker(horizon, store, { operationsRetentionDays: 90 }, now);

  assert.equal(result.opsUpserted, 0);
  assert.equal(rows.size, 0);
  assert.equal(calls.pagesFetched, 1, 'the older page is not fetched');
});

test('disabled retention continues ingesting old operations', async () => {
  const now = new Date('2026-08-31T12:00:00Z');
  const { horizon, calls } = horizonPaginated([
    [invokeOp('op-old', { created_at: '2026-05-03T12:00:00Z' })],
    [invokeOp('op-older', { created_at: '2026-05-02T12:00:00Z' })],
  ]);
  const { store, rows } = memoryStore([WALLET]);

  const result = await runOperationsWorker(horizon, store, { operationsRetentionDays: 0 }, now);

  assert.equal(result.opsUpserted, 2);
  assert.equal(rows.size, 2);
  assert.equal(calls.pagesFetched, 3, 'both data pages and the terminating empty page are read');
});

test('operations do not re-ingest history that a retention prune removed', async () => {
  const now = new Date('2026-08-31T12:00:00Z');
  const records = [invokeOp('op-old', { created_at: '2026-05-03T12:00:00Z' })];
  const { store, rows } = memoryStore([WALLET]);

  await runOperationsWorker(horizonReturning(records), store, { operationsRetentionDays: 0 }, now);
  assert.equal(rows.size, 1, 'the initial unrestricted pass writes the old operation');

  const pruningStore: PruningStore = {
    operation: {
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [id, row] of rows) {
          if (row.createdAt < where.createdAt.lt) {
            rows.delete(id);
            count++;
          }
        }
        return { count };
      },
    },
    contractSnapshot: { deleteMany: async () => ({ count: 0 }) },
  };
  await runPruningWorker(
    pruningStore,
    { operationsRetentionDays: 90, snapshotsRetentionDays: 0 },
    now,
  );
  assert.equal(rows.size, 0, 'the prune removes the old operation');

  const { horizon, calls } = horizonPaginated([records]);
  const second = await runOperationsWorker(horizon, store, { operationsRetentionDays: 90 }, now);

  assert.equal(second.opsUpserted, 0);
  assert.equal(rows.size, 0, 'the second pass does not restore the pruned operation');
  assert.equal(calls.pagesFetched, 1);
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

// ─── Backward walk (#964) ───────────────────────────────────────────────────

type HistoryRecord = ReturnType<typeof invokeOp>;
type Fetch = { cursor: string | null; via: 'call' | 'next'; order: string; limit: number };

/**
 * A Horizon stub over one wallet's whole operation history, newest first,
 * that pages the way Horizon does: `.cursor(token)` with `order('desc')`
 * starts at the record after that token, and a page's `next()` carries on
 * after its own last record. Past the end it returns an empty page.
 *
 * `fetches` is every page request the worker made, and `failOn(n)` makes the
 * n-th request from then on fail once, with an error the retry helper does
 * not retry.
 */
function horizonHistory(initial: HistoryRecord[]) {
  let history = [...initial];
  const fetches: Fetch[] = [];
  let failAt: number | null = null;

  function page(cursor: string | null, via: Fetch['via'], order: string, limit: number): unknown {
    fetches.push({ cursor, via, order, limit });
    if (failAt !== null && fetches.length === failAt) {
      failAt = null;
      throw new Error('horizon exploded: status=400');
    }
    const start = cursor === null ? 0 : history.findIndex((r) => r.paging_token === cursor) + 1;
    const records = history.slice(start, start + limit);
    const last = records[records.length - 1];
    return {
      records,
      next: async () => page(last ? last.paging_token : cursor, 'next', order, limit),
    };
  }

  const horizon = {
    operations: () => ({
      forAccount: () => {
        let order = 'asc';
        let limit = 10;
        let cursor: string | null = null;
        const builder = {
          order: (value: string) => {
            order = value;
            return builder;
          },
          limit: (value: number) => {
            limit = value;
            return builder;
          },
          cursor: (value: string) => {
            cursor = value;
            return builder;
          },
          call: async () => page(cursor, 'call', order, limit),
        };
        return builder;
      },
    }),
  } as unknown as Horizon.Server;

  return {
    horizon,
    fetches,
    /** Forgets the requests made so far, so the next assertion sees one tick's. */
    resetFetches: () => {
      fetches.length = 0;
    },
    failOn: (nthFromNow: number) => {
      failAt = fetches.length + nthFromNow;
    },
    /** New activity: records that arrive at the top of the history. */
    prepend: (records: HistoryRecord[]) => {
      history = [...records, ...history];
    },
  };
}

const NOW = new Date('2026-08-31T12:00:00Z');
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * `count` operations, newest first, one minute apart, the newest `startAgoMs`
 * before `NOW`. Ids sort the way Horizon's do: a newer operation has a larger
 * one. `type` picks each record's type from its position.
 */
function history(
  count: number,
  options: { startAgoMs?: number; firstId?: number; type?: (index: number) => string } = {},
): HistoryRecord[] {
  const startAgoMs = options.startAgoMs ?? 0;
  const firstId = options.firstId ?? 1_000_000;
  return Array.from({ length: count }, (_, i) =>
    invokeOp(String(firstId - i), {
      created_at: new Date(NOW.getTime() - startAgoMs - i * MINUTE_MS).toISOString(),
      ...(options.type && { type: options.type(i) }),
    }),
  );
}

/**
 * One run of the worker at `NOW`. The worker waits 100 ms after every page it
 * fetches, and these tests fetch well over a hundred, so they pass a wait that
 * returns at once.
 */
const tick = (horizon: Horizon.Server, store: OperationsStore, operationsRetentionDays = 0) =>
  runOperationsWorker(horizon, store, { operationsRetentionDays }, NOW, async () => {});

test('a wallet with 1,200 in-window invocations is fully stored after three ticks', async () => {
  const records = history(1_200);
  const { horizon, fetches, resetFetches } = horizonHistory(records);
  const { store, rows, wallets } = memoryStore([WALLET]);

  // Tick 1: nothing is stored and the walk has not started, so the walk runs
  // alone, from the newest operation, for its ten pages.
  const first = await tick(horizon, store, 90);
  assert.equal(first.opsUpserted, 500);
  assert.equal(rows.size, 500);
  assert.equal(fetches.length, 10);
  assert.equal(wallets[0]!.operationsCursor, records[499]!.paging_token);
  assert.equal(wallets[0]!.operationsBackfilledAt, null);

  // Tick 2: the forward check stops on the first page, at the newest stored
  // row, and the walk carries on from its cursor: operations 501 to 1,000.
  resetFetches();
  await tick(horizon, store, 90);
  assert.equal(rows.size, 1_000);
  assert.equal(fetches.length, 11);
  assert.deepEqual(fetches[0], { cursor: null, via: 'call', order: 'desc', limit: 50 });
  assert.deepEqual(fetches[1], {
    cursor: records[499]!.paging_token,
    via: 'call',
    order: 'desc',
    limit: 50,
  });
  assert.equal(wallets[0]!.operationsCursor, records[999]!.paging_token);
  assert.equal(wallets[0]!.operationsBackfilledAt, null);

  // Tick 3: the last 200, then the empty page that says the history is over.
  resetFetches();
  await tick(horizon, store, 90);
  assert.equal(rows.size, 1_200, 'all 1,200 invocations are stored after three ticks');
  assert.deepEqual([...rows.keys()].sort(), records.map((r) => r.id).sort());
  assert.equal(fetches.length, 1 + 4 + 1);
  assert.equal(wallets[0]!.operationsCursor, records[1_199]!.paging_token);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);

  // Tick 4: the walk is over, so only the newest page is fetched.
  resetFetches();
  const fourth = await tick(horizon, store, 90);
  assert.deepEqual(fetches, [{ cursor: null, via: 'call', order: 'desc', limit: 50 }]);
  assert.equal(rows.size, 1_200);
  assert.equal(fourth.opsUpserted, 50, 'the newest page is still refreshed');
});

test('the backward walk stops at the first operation older than the retention cutoff', async () => {
  // 120 operations inside a 90-day window, then 60 from 100 days ago.
  const inWindow = history(120);
  const tooOld = history(60, { startAgoMs: 100 * DAY_MS, firstId: 500_000 });
  const { horizon, fetches } = horizonHistory([...inWindow, ...tooOld]);
  const { store, rows, wallets } = memoryStore([WALLET]);

  const result = await tick(horizon, store, 90);

  assert.equal(result.opsUpserted, 120);
  assert.deepEqual([...rows.keys()].sort(), inWindow.map((r) => r.id).sort());
  // The first old operation is the 121st, on the third page. Nothing after
  // that page is asked for.
  assert.equal(fetches.length, 3);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
  // The cursor rests on the last operation inside the window.
  assert.equal(wallets[0]!.operationsCursor, inWindow[119]!.paging_token);
});

test('the retention cutoff also ends a walk that took more than one tick to reach it', async () => {
  const inWindow = history(700);
  const tooOld = history(300, { startAgoMs: 100 * DAY_MS, firstId: 500_000 });
  const { horizon } = horizonHistory([...inWindow, ...tooOld]);
  const { store, rows, wallets } = memoryStore([WALLET]);

  await tick(horizon, store, 90);
  assert.equal(rows.size, 500);
  assert.equal(wallets[0]!.operationsBackfilledAt, null);

  await tick(horizon, store, 90);
  assert.equal(rows.size, 700);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
});

test('with retention disabled the walk goes to the end of the history', async () => {
  const records = [...history(60), ...history(60, { startAgoMs: 400 * DAY_MS, firstId: 500_000 })];
  const { horizon } = horizonHistory(records);
  const { store, rows, wallets } = memoryStore([WALLET]);

  await tick(horizon, store, 0);

  assert.equal(rows.size, 120);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
});

test('the page cap counts operations of every type, and the walk gets past them', async () => {
  // The 500 newest operations are payments. The invocations are older than
  // that, which is where the worker used to stop looking for good.
  const payments = history(500, { type: () => 'payment' });
  const invocations = history(30, { startAgoMs: DAY_MS, firstId: 500_000 });
  const { horizon } = horizonHistory([...payments, ...invocations]);
  const { store, rows, wallets } = memoryStore([WALLET]);

  const first = await tick(horizon, store);
  assert.equal(first.opsUpserted, 0);
  assert.equal(rows.size, 0);
  // A payment is not stored, but the cursor still moves past it.
  assert.equal(wallets[0]!.operationsCursor, payments[499]!.paging_token);

  await tick(horizon, store);
  assert.deepEqual([...rows.keys()].sort(), invocations.map((r) => r.id).sort());
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
});

test('only the invocations among mixed operations are stored by the walk', async () => {
  const records = history(600, { type: (i) => (i % 3 === 0 ? 'invoke_host_function' : 'payment') });
  const { horizon } = horizonHistory(records);
  const { store, rows } = memoryStore([WALLET]);

  await tick(horizon, store);
  await tick(horizon, store);

  assert.equal(rows.size, 200);
  assert.ok([...rows.values()].every((row) => row.type === 'invoke_host_function'));
});

test('the cursor is saved after every page of the walk', async () => {
  const records = history(180);
  const { horizon } = horizonHistory(records);
  const { store, cursorWrites } = memoryStore([WALLET]);

  await tick(horizon, store);

  // Four pages: 50, 50, 50 and 30 operations. One write for each, at its last
  // operation, so a crash loses at most the page being read.
  assert.deepEqual(cursorWrites, [
    records[49]!.paging_token,
    records[99]!.paging_token,
    records[149]!.paging_token,
    records[179]!.paging_token,
  ]);
});

test('a page that fails does not end the walk: the next tick resumes from the saved cursor', async (t) => {
  const warnings: string[] = [];
  t.mock.method(logger, 'warn', (_fields: Record<string, unknown>, message: string) => {
    warnings.push(message);
  });
  const records = history(180);
  const { horizon, fetches, resetFetches, failOn } = horizonHistory(records);
  const { store, rows, wallets } = memoryStore([WALLET]);

  // The third page request fails.
  failOn(3);
  await tick(horizon, store);

  assert.equal(rows.size, 100, 'the two pages read before the failure are kept');
  assert.equal(wallets[0]!.operationsCursor, records[99]!.paging_token);
  assert.equal(wallets[0]!.operationsBackfilledAt, null, 'a failure is not the end of history');
  assert.deepEqual(warnings, ['operations.backfillPageFailed']);

  resetFetches();
  await tick(horizon, store);

  assert.equal(rows.size, 180);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
  // The forward check's page, then the walk from where it stopped.
  assert.equal(fetches[1]!.cursor, records[99]!.paging_token);
});

test('a history that ends exactly at the page cap is finished on the following tick', async () => {
  const records = history(500);
  const { horizon, fetches, resetFetches } = horizonHistory(records);
  const { store, rows, wallets } = memoryStore([WALLET]);

  await tick(horizon, store);
  assert.equal(rows.size, 500);
  // Ten full pages were read and the cap stopped the walk before it could
  // see that nothing follows.
  assert.equal(wallets[0]!.operationsBackfilledAt, null);

  resetFetches();
  await tick(horizon, store);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
  // The forward check's page and one empty page for the walk.
  assert.equal(fetches.length, 2);
});

test('a wallet with no operations at all is finished at once', async () => {
  const { horizon, fetches, resetFetches } = horizonHistory([]);
  const { store, rows, wallets, cursorWrites } = memoryStore([WALLET]);

  await tick(horizon, store);
  assert.equal(rows.size, 0);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
  assert.equal(wallets[0]!.operationsCursor, null);
  assert.deepEqual(cursorWrites, []);

  // From then on the forward check alone, one page a tick.
  resetFetches();
  await tick(horizon, store);
  assert.deepEqual(fetches, [{ cursor: null, via: 'call', order: 'desc', limit: 50 }]);
});

test('a wallet that already has rows but no cursor is walked from the top once', async () => {
  // A wallet indexed before the walk existed: the newest three operations are
  // stored, the five older ones never were.
  const records = history(8);
  const { horizon, fetches } = horizonHistory(records);
  const { store, rows, wallets } = memoryStore([WALLET]);
  await runOperationsWorker(horizonReturning(records.slice(0, 3)), store);
  wallets[0]!.operationsCursor = null;
  wallets[0]!.operationsBackfilledAt = null;
  assert.equal(rows.size, 3);

  await tick(horizon, store);

  assert.equal(rows.size, 8, 'the operations below the stored ones are picked up');
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
  // One page of data and the empty page after it. No forward check: the walk
  // starts at the newest operation.
  assert.deepEqual(
    fetches.map((f) => f.via),
    ['call', 'next'],
  );
  assert.equal(fetches[0]!.cursor, null);
});

test('new activity is picked up by the forward check while the walk is still going', async () => {
  const records = history(800);
  const { horizon, prepend } = horizonHistory(records);
  const { store, rows, wallets } = memoryStore([WALLET]);

  await tick(horizon, store);
  assert.equal(rows.size, 500);

  // Three operations arrive between the two ticks.
  const fresh = history(3, { startAgoMs: -5 * MINUTE_MS, firstId: 2_000_000 });
  prepend(fresh);
  await tick(horizon, store);

  assert.equal(rows.size, 803);
  for (const record of fresh) assert.ok(rows.has(record.id), 'the new operations are stored');
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
});

test('a finished wallet is never walked backwards again', async () => {
  // The walk is marked finished with its cursor 50 operations in, and the
  // newest operation is stored, so the forward check stops on its first page.
  const records = history(200);
  const { horizon, fetches } = horizonHistory(records);
  const { store, rows } = memoryStore([
    { ...WALLET, operationsCursor: records[49]!.paging_token, operationsBackfilledAt: NOW },
  ]);
  await runOperationsWorker(horizonReturning(records.slice(0, 1)), store);
  assert.equal(rows.size, 1);

  await tick(horizon, store);

  // One request, for the newest page. Nothing asks for what lies below the
  // cursor, so operations 51 to 200 stay unread.
  assert.deepEqual(fetches, [{ cursor: null, via: 'call', order: 'desc', limit: 50 }]);
  assert.equal(rows.size, 50);
});

test('clearing operationsBackfilledAt resumes the walk from the cursor, for a longer window', async () => {
  const inWindow = history(40);
  const older = history(40, { startAgoMs: 100 * DAY_MS, firstId: 500_000 });
  const { horizon, fetches, resetFetches } = horizonHistory([...inWindow, ...older]);
  const { store, rows, wallets } = memoryStore([WALLET]);

  await tick(horizon, store, 90);
  assert.equal(rows.size, 40);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);

  // The operator widens retention to 180 days and clears the marker, as
  // docs/RETENTION.md describes.
  wallets[0]!.operationsBackfilledAt = null;
  resetFetches();
  await tick(horizon, store, 180);

  assert.equal(rows.size, 80, 'the operations the wider window now covers are read');
  // The walk asked for what lies below its old cursor, not for the top again.
  assert.deepEqual(
    fetches.filter((f) => f.via === 'call').map((f) => f.cursor),
    [null, inWindow[39]!.paging_token],
  );
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
});

test('each wallet keeps its own cursor', async () => {
  const OTHER = { id: 'w2', pubkey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H' };
  const records = history(700);
  const { horizon } = horizonHistory(records);
  const { store, wallets } = memoryStore([
    WALLET,
    { ...OTHER, operationsCursor: records[599]!.paging_token },
  ]);

  await tick(horizon, store);

  // The first wallet started at the top and was stopped by the page cap. The
  // second resumed 600 operations in and reached the end.
  assert.equal(wallets[0]!.operationsCursor, records[499]!.paging_token);
  assert.equal(wallets[0]!.operationsBackfilledAt, null);
  assert.equal(wallets[1]!.operationsCursor, records[699]!.paging_token);
  assert.deepEqual(wallets[1]!.operationsBackfilledAt, NOW);
});

test('an operation exactly at the retention cutoff is kept, and the walk stops at the next one', async () => {
  // One minute inside a 90-day window, exactly on its edge, one minute outside.
  const records = history(3, { startAgoMs: 90 * DAY_MS - MINUTE_MS });
  const { horizon } = horizonHistory(records);
  const { store, rows, wallets } = memoryStore([WALLET]);

  await tick(horizon, store, 90);

  assert.deepEqual([...rows.keys()].sort(), [records[0]!.id, records[1]!.id].sort());
  assert.equal(wallets[0]!.operationsCursor, records[1]!.paging_token);
  assert.deepEqual(wallets[0]!.operationsBackfilledAt, NOW);
});

// ---------------------------------------------------------------------------
// Recorded Horizon responses (#974)
//
// The SDK's own `Horizon.Server` over `replayHorizon`: only the network is
// replaced, by the recordings in `@signet/fixtures`.
// ---------------------------------------------------------------------------

test("recorded: a tick over the deployer's pages stores its host-function operations, with their contract and function", async () => {
  const DEPLOYER = 'GC6IQQHUT4BXZYCJEM4AOKFD6ASWSXCEDXYPVA5NFKXSGOSRJX72KJMC';
  const INVOKE = 'HostFunctionTypeHostFunctionTypeInvokeContract';
  const newestPage = loadFixtureEnvelope<HorizonOperationsPage>('horizon-account-operations-page');
  const firstPage = loadFixtureEnvelope<HorizonOperationsPage>(
    'horizon-account-operations-first-page',
  );
  const end = loadFixtureEnvelope('horizon-account-operations-end');
  const newestRecords = newestPage.payload._embedded.records;
  const firstRecords = firstPage.payload._embedded.records;
  const newest = newestRecords[0]!;
  const funding = firstRecords[3]!;
  assert.equal(funding.type, 'create_account');

  // A wallet whose backward walk is four operations from the start of its
  // history, with its newest operation already stored. The forward check
  // reads the newest page, finds that operation in it and asks for no more;
  // the walk then reads the last four operations and ends. Every request is
  // one Horizon answered.
  const cursor = new URL(firstPage.request.methodOrPath, 'https://h').searchParams.get('cursor')!;
  const { store, rows, wallets } = memoryStore([
    { id: 'deployer', pubkey: DEPLOYER, operationsCursor: cursor },
  ]);
  rows.set(newest.id, {
    id: newest.id,
    walletId: 'deployer',
    type: newest.type,
    function: newest.function ?? null,
    sourceAccount: newest.source_account,
    createdAt: new Date(newest.created_at),
    transactionHash: newest.transaction_hash,
    successful: true,
  } as OperationCreate);

  const replay = replayHorizon([newestPage, firstPage, end]);
  let result;
  try {
    result = await runOperationsWorker(
      createHorizonServer(replay.url),
      store,
      { operationsRetentionDays: 0 },
      new Date(),
      async () => {},
    );
  } finally {
    replay.restore();
  }

  const older = (c: string) => `/accounts/${DEPLOYER}/operations?cursor=${c}&limit=50&order=desc`;
  assert.deepEqual(replay.requests, [
    `/accounts/${DEPLOYER}/operations?limit=50&order=desc`,
    older(cursor),
    older(funding.paging_token),
  ]);
  assert.deepEqual(replay.unanswered, []);

  // Every host-function operation of both pages is stored: 50 and 3. The
  // funding is a `create_account`, the one record of another type, and is not.
  const hostFunctionOps = [...newestRecords, ...firstRecords].filter(
    (op) => op.type === 'invoke_host_function',
  );
  assert.equal(hostFunctionOps.length, 53);
  assert.deepEqual([...rows.keys()].sort(), hostFunctionOps.map((op) => op.id).sort());
  assert.equal(rows.has(funding.id), false);
  assert.equal(result.opsUpserted, 53);
  assert.ok(wallets[0]!.operationsBackfilledAt);
  assert.equal(wallets[0]!.operationsCursor, funding.paging_token);
  // `function` stays what Horizon sent: the host function's type.
  for (const op of hostFunctionOps) assert.equal(rows.get(op.id)!.function, op.function);

  // #967: an invocation is stored with the contract and the function its
  // parameters name; an operation that calls no contract function has neither.
  const stored = (id: string) =>
    rows.get(id) as unknown as { decodedFunction?: string | null; contractAddress?: string | null };
  for (const op of hostFunctionOps) {
    const expected =
      op.function === INVOKE
        ? [
            scValToNative(xdr.ScVal.fromXDR(op.parameters![1]!.value, 'base64')) as string,
            Address.fromScVal(xdr.ScVal.fromXDR(op.parameters![0]!.value, 'base64')).toString(),
          ]
        : [null, null];
    assert.deepEqual(
      [stored(op.id).decodedFunction, stored(op.id).contractAddress],
      expected,
      `operation ${op.id} (${op.function})`,
    );
  }
  // Read off one record, so that the loop above is not the only witness: the
  // deployer's second operation calls `deploy_pool` on the contract its first
  // one created.
  const pool = firstRecords[1]!;
  assert.deepEqual(
    [stored(pool.id).decodedFunction, stored(pool.id).contractAddress],
    ['deploy_pool', 'CAII4K5S4GJPBSYXT4K2ZKYSEEAY6TA7GCTDIINFBATORY4N7PINPPPB'],
  );
  assert.equal(hostFunctionOps.filter((op) => op.function === INVOKE).length, 51);
});
