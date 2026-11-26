import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GET as legacyGet } from '../../../app/api/p/[handle]/operations/route.ts';
import {
  GET as v1Get,
  OPTIONS as v1Options,
} from '../../../app/api/v1/profiles/[handle]/operations/route.ts';
import { getV1ProfileOperations, type V1ProfileOperationsDeps } from './profile-operations.ts';
import { encodeCursor, parseCursor, parseOperationsCursor, V1Error } from './http.ts';
import type { Operation, Profile } from '../../profiles.ts';

function createDummyOperation(i: number): any {
  return {
    id: `op_${i}`,
    type: 'invoke_host_function',
    function: 'transfer',
    decoded_function: 'transfer',
    contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM66',
    source_account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    created_at: '2026-10-18T12:00:00.000Z',
    transaction_hash: `0x${i.toString().padStart(64, '0')}`,
    transaction_successful: true,
    asset_balance_changes: [{ asset_type: 'native', amount: '10' }],
  };
}

const mockProfile: Profile = {
  name: 'alice',
  wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  bio: 'test bio',
  joined: '2026-01-01',
  source: 'database',
};

test('getV1ProfileOperations supports database pagination across pages', async () => {
  const allOps = Array.from({ length: 5 }, (_, i) => createDummyOperation(i));

  const deps: V1ProfileOperationsDeps = {
    getProfile: async () => mockProfile,
    getPagedOperations: async (_handle, offset, limit) => {
      const slice = allOps.slice(offset, offset + limit);
      return { data: slice, total: allOps.length };
    },
  };

  // Page 1 (offset: 0, limit: 2)
  const page1 = await getV1ProfileOperations('alice', { offset: 0, limit: 2 }, deps);
  assert.equal(page1.data.length, 2);
  assert.equal(page1.data[0]?.id, 'op_0');
  assert.equal(page1.data[1]?.id, 'op_1');
  assert.equal(page1.meta.total, 5);
  assert.equal(page1.meta.truncated, false);
  assert.equal(page1.meta.cap, null);
  assert.equal(page1.meta.source, 'database');
  assert.ok(page1.meta.nextCursor);

  const cursor1 = parseCursor<{ offset: number }>(page1.meta.nextCursor);
  assert.equal(cursor1?.offset, 2);

  // Page 2 (offset: 2, limit: 2)
  const page2 = await getV1ProfileOperations('alice', { offset: cursor1!.offset, limit: 2 }, deps);
  assert.equal(page2.data.length, 2);
  assert.equal(page2.data[0]?.id, 'op_2');
  assert.equal(page2.data[1]?.id, 'op_3');
  assert.equal(page2.meta.total, 5);
  assert.ok(page2.meta.nextCursor);

  const cursor2 = parseCursor<{ offset: number }>(page2.meta.nextCursor);
  assert.equal(cursor2?.offset, 4);

  // Page 3 (offset: 4, limit: 2) - last page
  const page3 = await getV1ProfileOperations('alice', { offset: cursor2!.offset, limit: 2 }, deps);
  assert.equal(page3.data.length, 1);
  assert.equal(page3.data[0]?.id, 'op_4');
  assert.equal(page3.meta.total, 5);
  assert.equal(page3.meta.nextCursor, null);
});

test('Horizon fallback truncated at the cap sets truncated: true, total: null, and nextCursor: null once cap is reached', async () => {
  const cap = 100;
  const horizonOps: Operation[] = Array.from({ length: cap }, (_, i) => createDummyOperation(i));

  const deps: V1ProfileOperationsDeps = {
    getProfile: async () => mockProfile,
    getPagedOperations: async () => null, // triggers fallback
    getOperationsResult: async () => ({
      operations: horizonOps,
      truncated: true,
      cap,
      source: 'horizon',
    }),
  };

  // First page (offset: 0, limit: 50): has more records before cap
  const page1 = await getV1ProfileOperations('alice', { offset: 0, limit: 50 }, deps);
  assert.equal(page1.data.length, 50);
  assert.equal(page1.meta.total, null, 'meta.total must be null when DB did not answer');
  assert.equal(page1.meta.truncated, true);
  assert.equal(page1.meta.cap, 100);
  assert.equal(page1.meta.source, 'horizon');
  assert.ok(page1.meta.nextCursor, 'first page before cap should have nextCursor');

  const cursor1 = parseCursor<{ offset: number }>(page1.meta.nextCursor);
  assert.equal(cursor1?.offset, 50);

  // Second page (offset: 50, limit: 50): reaches the cap
  const page2 = await getV1ProfileOperations('alice', { offset: cursor1!.offset, limit: 50 }, deps);
  assert.equal(page2.data.length, 50);
  assert.equal(page2.meta.total, null);
  assert.equal(page2.meta.truncated, true);
  assert.equal(page2.meta.cap, 100);
  assert.equal(page2.meta.nextCursor, null, 'nextCursor must be null once cap is reached');
});

test('v1 operations shape drops asset_balance_changes', async () => {
  const dummy = createDummyOperation(1);
  const deps: V1ProfileOperationsDeps = {
    getProfile: async () => mockProfile,
    getPagedOperations: async () => ({ data: [dummy], total: 1 }),
  };

  const result = await getV1ProfileOperations('alice', { offset: 0, limit: 1 }, deps);
  const op = result.data[0];
  assert.ok(op);

  assert.equal(op.id, 'op_1');
  assert.equal(op.type, 'invoke_host_function');
  assert.equal(op.function, 'transfer');
  assert.equal(op.contract, 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM66');
  assert.equal(op.sourceAccount, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
  assert.equal(op.createdAt, '2026-10-18T12:00:00.000Z');
  assert.equal(op.successful, true);
  assert.equal(
    'asset_balance_changes' in op,
    false,
    'asset_balance_changes must be dropped from v1',
  );
});

test('unknown handle throws V1Error not_found', async () => {
  const deps: V1ProfileOperationsDeps = {
    getPagedOperations: async () => null,
    getProfile: async () => null,
  };

  await assert.rejects(
    () => getV1ProfileOperations('unknown_handle', { offset: 0, limit: 10 }, deps),
    (err: unknown) => {
      assert.ok(err instanceof V1Error);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

/**
 * The worked pagination example in docs/API_V1.md is generated from this
 * fixture. The test below fails when the documented body stops matching what
 * the endpoint returns for it, so the first example an integrator copies cannot
 * drift apart again.
 */
const DOC_HANDLE = 'ada';
const DOC_OPS: any[] = [
  {
    id: '1884231',
    type: 'invoke_host_function',
    decoded_function: 'transfer',
    contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM66',
    source_account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    created_at: '2026-09-30T14:03:22.000Z',
    transaction_hash: '5c1f0e6d9b3a2f8c4d7e1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d',
    transaction_successful: true,
  },
  {
    id: '1884194',
    type: 'invoke_host_function',
    decoded_function: 'mint',
    contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM66',
    source_account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    created_at: '2026-09-29T08:41:10.000Z',
    transaction_hash: '9a0701b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e',
    transaction_successful: true,
  },
  {
    id: '1884001',
    type: 'invoke_host_function',
    decoded_function: 'transfer',
    contract: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM66',
    source_account: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    created_at: '2026-09-27T19:55:03.000Z',
    transaction_hash: 'e2d40a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e',
    transaction_successful: true,
  },
];

test('the pagination examples in docs/API_V1.md match this fixture', async () => {
  const deps: V1ProfileOperationsDeps = {
    getPagedOperations: async (_handle, offset, limit) => ({
      data: DOC_OPS.slice(offset, offset + limit),
      total: DOC_OPS.length,
    }),
  };

  const page1 = await getV1ProfileOperations(DOC_HANDLE, { offset: 0, limit: 2 }, deps);
  const page2 = await getV1ProfileOperations(DOC_HANDLE, { offset: 2, limit: 2 }, deps);

  const doc = readFileSync(new URL('../../../../../docs/API_V1.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## Pagination'), doc.indexOf('### Bounded reads'));
  const examples = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!));

  assert.equal(examples.length, 2, 'the pagination section documents two pages');
  assert.deepEqual(examples[0], page1);
  assert.deepEqual(examples[1], page2);
  assert.match(section, /GET \/api\/v1\/profiles\/ada\/operations\?limit=2/);
  assert.match(section, /cursor=AXsib2Zmc2V0IjoyfQ/);
});

test('legacy /api/p/[handle]/operations still works and carries Deprecation header', async () => {
  const req = new Request('http://localhost/api/p/alice/operations') as any;
  const ctx = { params: Promise.resolve({ handle: 'alice' }) };

  const res = await legacyGet(req, ctx);
  assert.ok(res.status === 200 || res.status === 429);

  if (res.status === 200) {
    const deprecation = res.headers.get('Deprecation');
    assert.ok(deprecation, 'Legacy route must carry Deprecation header');
    assert.ok(
      deprecation.includes('/api/v1/profiles/alice/operations'),
      'Deprecation header must point to v1 route',
    );
  }
});

test('v1 route GET /api/v1/profiles/[handle]/operations handles requests and OPTIONS preflight', async () => {
  const req = new Request('http://localhost/api/v1/profiles/alice/operations');
  const ctx = { params: Promise.resolve({ handle: 'alice' }) };

  const res = await v1Get(req, ctx);
  assert.ok(res.status === 200 || res.status === 404);

  const optRes = await v1Options(
    new Request('http://localhost/api/v1/profiles/alice/operations', { method: 'OPTIONS' }),
    ctx,
  );
  assert.equal(optRes.status, 204);
  assert.equal(optRes.headers.get('Access-Control-Allow-Origin'), '*');
});

test('keyset pagination: page 1 is read, a newer row is inserted into the fake, page 2 is read, and the two pages share no ids and skip none', async () => {
  const ops = [
    { ...createDummyOperation(1), id: 'op_1', created_at: '2026-11-21T07:04:00.000Z' },
    { ...createDummyOperation(2), id: 'op_2', created_at: '2026-11-21T07:03:00.000Z' },
    { ...createDummyOperation(3), id: 'op_3', created_at: '2026-11-21T07:02:00.000Z' },
    { ...createDummyOperation(4), id: 'op_4', created_at: '2026-11-21T07:01:00.000Z' },
  ];

  const fakeStore = [...ops];

  const deps: V1ProfileOperationsDeps = {
    getProfile: async () => mockProfile,
    getPagedOperations: async (_handle, pagination, limit) => {
      let filtered = fakeStore;
      if (typeof pagination === 'object' && pagination?.cursor) {
        const cursor = pagination.cursor;
        const cursorDate = new Date(cursor.createdAt).getTime();
        filtered = fakeStore.filter((op) => {
          const opDate = new Date(op.created_at ?? op.createdAt).getTime();
          if (opDate !== cursorDate) return opDate < cursorDate;
          return op.id < cursor.id;
        });
      }
      const pageRows = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      return { data: pageRows, total: fakeStore.length, hasMore } as any;
    },
  };

  // Page 1 (limit: 2)
  const page1 = await getV1ProfileOperations('alice', { limit: 2 }, deps);
  assert.equal(page1.data.length, 2);
  assert.equal(page1.data[0]?.id, 'op_1');
  assert.equal(page1.data[1]?.id, 'op_2');
  assert.ok(page1.meta.nextCursor);

  // A newer row is inserted into the fake
  fakeStore.unshift({
    ...createDummyOperation(0),
    id: 'op_0',
    created_at: '2026-11-21T07:05:00.000Z',
  });

  // Page 2 is read using nextCursor
  const cursor = parseOperationsCursor(page1.meta.nextCursor);
  const page2 = await getV1ProfileOperations('alice', { cursor, limit: 2 }, deps);
  assert.equal(page2.data.length, 2);
  assert.equal(page2.data[0]?.id, 'op_3');
  assert.equal(page2.data[1]?.id, 'op_4');

  // Verify: the two pages share no ids and skip none
  const page1Ids = page1.data.map((o) => o.id);
  const page2Ids = page2.data.map((o) => o.id);
  const sharedIds = page1Ids.filter((id) => page2Ids.includes(id));
  assert.deepEqual(sharedIds, []);
  assert.deepEqual([...page1Ids, ...page2Ids], ['op_1', 'op_2', 'op_3', 'op_4']);
});

test('v1 operations route rejects malformed cursors with 400 and parameter: cursor', async () => {
  const badCursors = [
    encodeCursor({ offset: 'x' }),
    encodeCursor({ offset: -5 }),
    encodeCursor({ createdAt: 'nope', id: 1 }, 2),
  ];

  for (const cursor of badCursors) {
    const req = new Request(`http://localhost/api/v1/profiles/alice/operations?cursor=${cursor}`);
    const ctx = { params: Promise.resolve({ handle: 'alice' }) };
    const res = await v1Get(req, ctx);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'bad_request');
    assert.equal(json.error.details?.parameter, 'cursor');
  }
});
