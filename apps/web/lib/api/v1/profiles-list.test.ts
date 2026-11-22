import assert from 'node:assert/strict';
import test from 'node:test';
import { GET, PROFILES_CACHE_CONTROL } from '../../../app/api/v1/profiles/route.ts';
import { parseCursor, V1Error } from './http.ts';
import {
  getV1ProfilesList,
  type ProfilesListStore,
  type V1ProfilesListCursor,
  type V1ProfilesListDeps,
} from './profiles-list.ts';
import { expectMatchesSchema } from './test-utils.ts';

// Distinct, valid G-addresses: G + 55 base32 characters.
const wallet = (i: number) => `G${String.fromCharCode(65 + i).repeat(55)}`;

interface Row {
  handle: string;
  createdAt: Date;
  /** Every wallet still bound to the profile. Empty once they were all released. */
  wallets: { pubkey: string; isPrimary: boolean }[];
}

const row = (handle: string, day: string, wallets: Row['wallets']): Row => ({
  handle,
  createdAt: new Date(`${day}T00:00:00.000Z`),
  wallets,
});

/**
 * A `ProfilesListStore` over rows in memory that answers the way Postgres
 * would: the wallet filter, the keyset on the handle, the order and the page
 * size are all applied here, so a query that left one of them out shows.
 * `queries` records every `findMany`.
 */
function memoryStore(rows: Row[]) {
  const queries: Parameters<ProfilesListStore['profile']['findMany']>[0][] = [];
  const bound = () => rows.filter((r) => r.wallets.length > 0);
  const store: ProfilesListStore = {
    profile: {
      findMany: async (args) => {
        queries.push(args);
        assert.deepEqual(args.where.wallets, { some: {} });
        assert.deepEqual(args.orderBy, { handle: 'asc' });
        const after = args.where.handle?.gt;
        return bound()
          .filter((r) => after === undefined || r.handle > after)
          .sort((a, b) => (a.handle < b.handle ? -1 : 1))
          .slice(0, args.take)
          .map((r) => ({
            handle: r.handle,
            createdAt: r.createdAt,
            wallets: r.wallets.filter((w) => w.isPrimary).slice(0, 1),
          }));
      },
      count: async (args) => {
        assert.deepEqual(args.where, { wallets: { some: {} } });
        return bound().length;
      },
    },
  };
  return { store, queries };
}

/** Seven profiles, stored out of order. */
function sevenProfiles(): Row[] {
  return ['mallory', 'alice', 'erin', 'bob', 'dave', 'carol', 'frank'].map((handle, i) =>
    row(handle, `2026-0${i + 1}-15`, [{ pubkey: wallet(i), isPrimary: true }]),
  );
}

const noChain: V1ProfilesListDeps['fetchLiveDirectory'] = async () => {
  throw new Error('the chain must not be asked when the database answered');
};

test('three pages walk every handle once, in handle order', async () => {
  const { store, queries } = memoryStore(sevenProfiles());
  const deps = { store, fetchLiveDirectory: noChain };
  const seen: string[] = [];
  let cursor: V1ProfilesListCursor | null = null;
  for (let page = 0; page < 3; page++) {
    const { data, meta, degraded } = await getV1ProfilesList({ cursor, limit: 3 }, deps);
    await expectMatchesSchema({ data, meta }, 'listProfiles', 200);
    assert.equal(meta.source, 'database');
    assert.equal(meta.total, 7);
    assert.equal(meta.truncated, false);
    assert.equal(degraded, false);
    seen.push(...data.map((p) => p.handle));
    cursor = meta.nextCursor ? parseCursor<V1ProfilesListCursor>(meta.nextCursor) : null;
    assert.equal(cursor === null, page === 2, `page ${page + 1} cursor`);
  }
  assert.deepEqual(seen, ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'mallory']);
  // Each page asked the database for one row more than it returns, after the
  // previous page's last handle.
  assert.deepEqual(
    queries.map((q) => [q.where.handle?.gt, q.take]),
    [
      [undefined, 4],
      ['carol', 4],
      ['frank', 4],
    ],
  );
});

test('a handle claimed between two pages does not shift or repeat a page', async () => {
  const rows = sevenProfiles();
  const { store } = memoryStore(rows);
  const first = await getV1ProfilesList({ limit: 3 }, { store });
  assert.deepEqual(
    first.data.map((p) => p.handle),
    ['alice', 'bob', 'carol'],
  );

  // Two new handles: one before the cursor, one after it.
  rows.push(row('aaron', '2026-11-01', [{ pubkey: wallet(8), isPrimary: true }]));
  rows.push(row('daisy', '2026-11-02', [{ pubkey: wallet(9), isPrimary: true }]));
  const cursor = parseCursor<V1ProfilesListCursor>(first.meta.nextCursor);
  const second = await getV1ProfilesList({ cursor, limit: 3 }, { store });

  assert.deepEqual(
    second.data.map((p) => p.handle),
    ['daisy', 'dave', 'erin'],
  );
  assert.equal(second.meta.total, 9);
});

test('a row carries the primary wallet and when the profile was first seen', async () => {
  const { store } = memoryStore([
    row('alice', '2026-03-04', [
      { pubkey: wallet(1), isPrimary: false },
      { pubkey: wallet(0), isPrimary: true },
    ]),
    // Wallets, but none of them the primary: still listed, with no wallet to name.
    row('bob', '2026-05-06', [{ pubkey: wallet(2), isPrimary: false }]),
  ]);

  const res = await getV1ProfilesList({}, { store });

  assert.deepEqual(res.data, [
    { handle: 'alice', primaryWallet: wallet(0), joinedAt: '2026-03-04T00:00:00.000Z' },
    { handle: 'bob', primaryWallet: null, joinedAt: '2026-05-06T00:00:00.000Z' },
  ]);
  await expectMatchesSchema({ data: res.data, meta: res.meta }, 'listProfiles', 200);
});

test('a profile whose wallets were all released is left out', async () => {
  const { store } = memoryStore([
    row('alice', '2026-01-01', [{ pubkey: wallet(0), isPrimary: true }]),
    row('ghost', '2026-01-02', []),
    row('zed', '2026-01-03', [{ pubkey: wallet(1), isPrimary: true }]),
  ]);

  const { data, meta } = await getV1ProfilesList({}, { store });

  assert.deepEqual(
    data.map((p) => p.handle),
    ['alice', 'zed'],
  );
  // The count is of what is listed, not of every Profile row.
  assert.equal(meta.total, 2);
  assert.equal(meta.nextCursor, null);
});

test('a last page that is exactly full has no next cursor', async () => {
  const { store } = memoryStore(sevenProfiles().slice(0, 6));
  const first = await getV1ProfilesList({ limit: 3 }, { store });
  const second = await getV1ProfilesList(
    { cursor: parseCursor<V1ProfilesListCursor>(first.meta.nextCursor), limit: 3 },
    { store },
  );
  assert.equal(second.data.length, 3);
  assert.equal(second.meta.nextCursor, null, 'six handles in pages of three end on the second');
});

test('an empty database is an answer: no handles, and not truncated', async () => {
  const { store } = memoryStore([]);
  const res = await getV1ProfilesList({}, { store, fetchLiveDirectory: noChain });
  assert.deepEqual(res, {
    data: [],
    meta: { nextCursor: null, total: 0, truncated: false, source: 'database' },
    degraded: false,
  });
});

test('with no database the registry events answer, as a partial list', async () => {
  const live = [
    { handle: 'erin', wallet: wallet(4) },
    { handle: 'alice', wallet: wallet(0) },
    { handle: 'carol', wallet: wallet(2) },
    { handle: 'bob', wallet: wallet(1) },
    { handle: 'dave', wallet: wallet(3) },
  ];
  const deps: V1ProfilesListDeps = { store: null, fetchLiveDirectory: async () => live };

  const first = await getV1ProfilesList({ limit: 2 }, deps);
  await expectMatchesSchema({ data: first.data, meta: first.meta }, 'listProfiles', 200);
  assert.deepEqual(first.data, [
    { handle: 'alice', primaryWallet: wallet(0), joinedAt: null },
    { handle: 'bob', primaryWallet: wallet(1), joinedAt: null },
  ]);
  // The event stream only reaches back as far as the RPC keeps events, so the
  // list is never presented as whole, and it has no count.
  assert.equal(first.meta.source, 'chain');
  assert.equal(first.meta.truncated, true);
  assert.equal(first.meta.total, null);
  // No database is how this deployment is set up, not a failure.
  assert.equal(first.degraded, false);

  const seen = first.data.map((p) => p.handle);
  let cursor = parseCursor<V1ProfilesListCursor>(first.meta.nextCursor);
  while (cursor) {
    const next = await getV1ProfilesList({ cursor, limit: 2 }, deps);
    seen.push(...next.data.map((p) => p.handle));
    cursor = parseCursor<V1ProfilesListCursor>(next.meta.nextCursor);
  }
  assert.deepEqual(seen, ['alice', 'bob', 'carol', 'dave', 'erin']);
});

test('the chain layer drops what is not a handle and never serves an empty wallet', async () => {
  const res = await getV1ProfilesList(
    {},
    {
      store: null,
      fetchLiveDirectory: async () => [
        { handle: 'Not A Handle!', wallet: wallet(0) },
        { handle: 'zed', wallet: '' },
      ],
    },
  );
  assert.deepEqual(res.data, [{ handle: 'zed', primaryWallet: null, joinedAt: null }]);
  await expectMatchesSchema({ data: res.data, meta: res.meta }, 'listProfiles', 200);
});

test('with neither layer the answer says it is incomplete, not empty', async () => {
  const res = await getV1ProfilesList({}, { store: null, fetchLiveDirectory: async () => null });
  assert.deepEqual(res, {
    data: [],
    meta: { nextCursor: null, total: null, truncated: true, source: 'none' },
    degraded: true,
  });
  await expectMatchesSchema({ data: res.data, meta: res.meta }, 'listProfiles', 200);

  // A chain read that throws is the same as one that could not answer.
  const thrown = await getV1ProfilesList(
    {},
    {
      store: null,
      fetchLiveDirectory: async () => {
        throw new Error('rpc is down');
      },
    },
  );
  assert.equal(thrown.meta.source, 'none');
});

test('a database that fails falls back to the chain and marks the answer degraded', async () => {
  const failing: ProfilesListStore = {
    profile: {
      findMany: async () => {
        throw new Error("Can't reach database server");
      },
      count: async () => 0,
    },
  };

  const res = await getV1ProfilesList(
    {},
    { store: failing, fetchLiveDirectory: async () => [{ handle: 'alice', wallet: wallet(0) }] },
  );

  assert.equal(res.meta.source, 'chain');
  assert.deepEqual(
    res.data.map((p) => p.handle),
    ['alice'],
  );
  // The preferred layer failed, so this answer must not be cached.
  assert.equal(res.degraded, true);
});

test('limit is kept between 1 and 100, and defaults to 25', async () => {
  const many = Array.from({ length: 130 }, (_, i) =>
    row(`user${String(i).padStart(3, '0')}`, '2026-01-01', [
      { pubkey: wallet(i % 26), isPrimary: true },
    ]),
  );
  const { store } = memoryStore(many);

  assert.equal((await getV1ProfilesList({}, { store })).data.length, 25);
  assert.equal((await getV1ProfilesList({ limit: 1000 }, { store })).data.length, 100);
  assert.equal((await getV1ProfilesList({ limit: 0 }, { store })).data.length, 1);
});

test('a cursor that is not one this endpoint issued is a 400', async () => {
  const { store } = memoryStore(sevenProfiles());
  for (const cursor of [{}, { handle: 42 }, { handle: 'Not A Handle!' }, { handle: '' }]) {
    await assert.rejects(
      getV1ProfilesList({ cursor: cursor as unknown as V1ProfilesListCursor }, { store }),
      (err: unknown) => err instanceof V1Error && err.code === 'bad_request',
      JSON.stringify(cursor),
    );
  }
});

test('the route refuses a bad limit or cursor before it reads anything', async () => {
  const limit = await GET(new Request('http://localhost/api/v1/profiles?limit=0'));
  assert.equal(limit.status, 400);
  await expectMatchesSchema(limit, 'listProfiles');
  assert.equal(limit.headers.get('Cache-Control'), 'no-store');

  const cursor = await GET(new Request('http://localhost/api/v1/profiles?cursor=@@'));
  assert.equal(cursor.status, 400);
  await expectMatchesSchema(cursor, 'listProfiles');
});

test('the route caches with the profile class of docs/API_V1.md', () => {
  assert.equal(PROFILES_CACHE_CONTROL, 'public, max-age=30, stale-while-revalidate=60');
});
