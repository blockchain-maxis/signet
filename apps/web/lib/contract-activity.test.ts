import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getContractActivity,
  getContractInvocations,
  getContractOperationsPage,
  parsePaging,
  type ContractActivityDb,
  type InvocationRow,
  type SnapshotRow,
} from './contract-activity.ts';
import { attributeContractWithDeps, type Attribution } from './contract-attribution.ts';

const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const HANDLE = 'aquawolf';
const WALLET_A = `G${'A'.repeat(55)}`;
const WALLET_B = `G${'B'.repeat(55)}`;
const STRANGER = `G${'C'.repeat(55)}`;

const attributed: Attribution = {
  status: 'attributed',
  source: 'database',
  contract: {
    address: CONTRACT,
    network: 'testnet',
    deployerPubkey: WALLET_A,
    deployTxHash: 'deploy',
    deployedAt: '2026-01-01T00:00:00.000Z',
    wasmHash: null,
  },
};

function snap(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    txCount24h: 3,
    txCountTotal: 40,
    totalIsFloor: false,
    countedSince: new Date('2026-02-01T00:00:00Z'),
    lastActivity: new Date('2026-03-01T00:00:00Z'),
    capturedAt: new Date('2026-03-02T00:00:00Z'),
    ...overrides,
  };
}

function inv(i: number, sourceAccount: string): InvocationRow {
  return {
    id: `tx${i}:0`,
    function: i % 2 ? 'transfer' : null,
    sourceAccount,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - i)),
    txHash: `tx${i}`,
    successful: i % 3 !== 0,
  };
}

/** In-memory seam that honours skip/take and the caller filter like the DB does. */
function makeDb(snapshots: SnapshotRow[] | undefined, invocations: InvocationRow[] | undefined) {
  const seen = { wallets: 0, invocations: 0 };
  const db: ContractActivityDb = {
    listSnapshots: async () => snapshots,
    listInvocations: async ({ offset, limit, sourceAccounts }) => {
      seen.invocations += 1;
      if (!invocations) return undefined;
      const matching = invocations.filter(
        (r) => !sourceAccounts || sourceAccounts.includes(r.sourceAccount),
      );
      return { rows: matching.slice(offset, offset + limit), total: matching.length };
    },
    listHandleWallets: async () => {
      seen.wallets += 1;
      return invocations ? [WALLET_A, WALLET_B] : undefined;
    },
  };
  return { db, seen };
}

test('totalIsFloor and countedSince pass through from the snapshot', async () => {
  const row = snap({ totalIsFloor: true, txCountTotal: 1000 });
  const { snapshot, source } = await getContractActivity(CONTRACT, {
    db: makeDb([row], []).db,
  });
  assert.equal(source, 'database');
  assert.equal(snapshot?.totalIsFloor, true);
  assert.equal(snapshot?.txCountTotal, 1000);
  assert.deepEqual(snapshot?.countedSince, row.countedSince);
  assert.equal(snapshot?.txCount24h, 3);
  assert.deepEqual(snapshot?.lastActivity, row.lastActivity);
  assert.deepEqual(snapshot?.capturedAt, row.capturedAt);
});

test('a snapshot with a null countedSince gives null, never zero usage', async () => {
  const legacy = snap({ countedSince: null, txCount24h: 0, txCountTotal: 0 });
  const result = await getContractActivity(CONTRACT, { db: makeDb([legacy], []).db });
  assert.equal(result.snapshot, null);
  assert.equal(result.source, 'database');
});

test('no snapshot gives null', async () => {
  const result = await getContractActivity(CONTRACT, { db: makeDb([], []).db });
  assert.equal(result.snapshot, null);
  assert.equal(result.source, 'database');
});

test('the newest snapshot wins, and an unmeasured newest is not replaced by an older one', async () => {
  const older = snap({ txCountTotal: 10, capturedAt: new Date('2026-03-01T00:00:00Z') });
  const newer = snap({ txCountTotal: 99, capturedAt: new Date('2026-03-05T00:00:00Z') });
  const picked = await getContractActivity(CONTRACT, { db: makeDb([older, newer], []).db });
  assert.equal(picked.snapshot?.txCountTotal, 99);

  const unmeasuredNewest = snap({ countedSince: null, capturedAt: new Date('2026-03-09T00:00:00Z') });
  const none = await getContractActivity(CONTRACT, {
    db: makeDb([older, unmeasuredNewest], []).db,
  });
  assert.equal(none.snapshot, null);
});

test('without a database the snapshot is null and the source is none', async () => {
  const result = await getContractActivity(CONTRACT, { db: makeDb(undefined, undefined).db });
  assert.deepEqual(result, { snapshot: null, source: 'none' });
});

test('invocations map to the Operation rows OperationsList renders', async () => {
  const rows = [inv(1, WALLET_A), inv(2, STRANGER)];
  const page = await getContractInvocations(
    CONTRACT,
    { offset: 0, limit: 10 },
    { db: makeDb([], rows).db },
  );
  assert.equal(page.total, 2);
  assert.equal(page.source, 'database');
  assert.deepEqual(page.data[0], {
    id: 'tx1:0',
    type: 'invoke_host_function',
    function: 'transfer',
    source_account: WALLET_A,
    created_at: rows[0]!.createdAt.toISOString(),
    transaction_hash: 'tx1',
    transaction_successful: true,
  });
  // A sub-call with no function name carries no `function`.
  assert.equal(page.data[1]!.function, undefined);
});

test('invocations page with offset/limit and an honest total', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => inv(i + 1, WALLET_A));
  const { db } = makeDb([], rows);
  const second = await getContractInvocations(CONTRACT, { offset: 3, limit: 3 }, { db });
  assert.equal(second.total, 7);
  assert.deepEqual(
    second.data.map((r) => r.id),
    ['tx4:0', 'tx5:0', 'tx6:0'],
  );
});

test('sourceAccounts restricts to those callers; an empty list matches nothing', async () => {
  const rows = [inv(1, WALLET_A), inv(2, STRANGER), inv(3, WALLET_B)];
  const { db, seen } = makeDb([], rows);
  const mine = await getContractInvocations(
    CONTRACT,
    { offset: 0, limit: 10, sourceAccounts: [WALLET_A, WALLET_B] },
    { db },
  );
  assert.equal(mine.total, 2);
  assert.deepEqual(
    mine.data.map((r) => r.source_account),
    [WALLET_A, WALLET_B],
  );

  const none = await getContractInvocations(
    CONTRACT,
    { offset: 0, limit: 10, sourceAccounts: [] },
    { db },
  );
  assert.deepEqual(none, { data: [], total: 0, source: 'database' });
  assert.equal(seen.invocations, 1, 'an empty caller list must not reach the database');
});

test('without a database the invocation list is empty with source none', async () => {
  const page = await getContractInvocations(
    CONTRACT,
    { offset: 0, limit: 10 },
    { db: makeDb(undefined, undefined).db },
  );
  assert.deepEqual(page, { data: [], total: 0, source: 'none' });
});

test('parsePaging defaults to 25 and clamps limit to 1-100 and offset to 0', () => {
  const p = (q: string) => parsePaging(new URLSearchParams(q));
  assert.deepEqual(p(''), { offset: 0, limit: 25 });
  assert.deepEqual(p('limit=1000'), { offset: 0, limit: 100 });
  assert.deepEqual(p('limit=-5'), { offset: 0, limit: 1 });
  assert.deepEqual(p('limit=abc&offset=zzz'), { offset: 0, limit: 25 });
  assert.deepEqual(p('offset=-9&limit=50'), { offset: 0, limit: 50 });
  assert.deepEqual(p('offset=40&limit=10'), { offset: 40, limit: 10 });
});

test('route: an unattributed contract is a 404', async () => {
  const { db, seen } = makeDb([], [inv(1, WALLET_A)]);
  const res = await getContractOperationsPage(HANDLE, CONTRACT, new URLSearchParams(), {
    db,
    attribute: async () => ({ status: 'not-attributed' }),
  });
  assert.equal(res.status, 404);
  assert.equal(seen.invocations, 0, 'nothing is read before attribution passes');
});

test('route: an invalid address is a 404 through the real attribution rule', async () => {
  const { db, seen } = makeDb([], [inv(1, WALLET_A)]);
  const res = await getContractOperationsPage(HANDLE, 'not-an-address', new URLSearchParams(), {
    db,
    attribute: (handle, address) => attributeContractWithDeps(handle, address),
  });
  assert.equal(res.status, 404);
  assert.equal(seen.invocations, 0);
});

test('route: an unavailable attribution lookup is a 503, not a 404', async () => {
  const res = await getContractOperationsPage(HANDLE, CONTRACT, new URLSearchParams(), {
    db: makeDb([], []).db,
    attribute: async () => ({ status: 'unavailable' }),
  });
  assert.equal(res.status, 503);
});

test('route: limit is clamped to 1-100 and meta follows the profile route shape', async () => {
  const rows = Array.from({ length: 130 }, (_, i) => inv(i + 1, WALLET_A));
  const { db } = makeDb([], rows);
  const res = await getContractOperationsPage(
    HANDLE,
    CONTRACT,
    new URLSearchParams('limit=500'),
    { db, attribute: async () => attributed },
  );
  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.equal(res.body.data.length, 100);
  assert.deepEqual(res.body.meta, {
    total: 130,
    offset: 0,
    limit: 100,
    hasMore: true,
    truncated: false,
    cap: null,
    source: 'database',
  });

  const tail = await getContractOperationsPage(
    HANDLE,
    CONTRACT,
    new URLSearchParams('offset=100&limit=100'),
    { db, attribute: async () => attributed },
  );
  assert.equal(tail.status === 200 && tail.body.meta.hasMore, false);
});

test('route: mine=1 returns only rows from the handle wallets', async () => {
  const rows = [inv(1, WALLET_A), inv(2, STRANGER), inv(3, WALLET_B), inv(4, STRANGER)];
  const { db } = makeDb([], rows);
  const deps = { db, attribute: async () => attributed };

  const mine = await getContractOperationsPage(
    HANDLE,
    CONTRACT,
    new URLSearchParams('mine=1'),
    deps,
  );
  assert.equal(mine.status, 200);
  if (mine.status !== 200) return;
  assert.equal(mine.body.meta.total, 2);
  assert.ok(mine.body.data.every((r) => [WALLET_A, WALLET_B].includes(r.source_account ?? '')));

  const all = await getContractOperationsPage(HANDLE, CONTRACT, new URLSearchParams(), deps);
  assert.equal(all.status === 200 && all.body.meta.total, 4);
});

test('route: without a database the list is empty with source none', async () => {
  const res = await getContractOperationsPage(
    HANDLE,
    CONTRACT,
    new URLSearchParams('mine=1'),
    { db: makeDb(undefined, undefined).db, attribute: async () => attributed },
  );
  assert.equal(res.status, 200);
  if (res.status !== 200) return;
  assert.deepEqual(res.body.data, []);
  assert.equal(res.body.meta.total, 0);
  assert.equal(res.body.meta.source, 'none');
});
