import assert from 'node:assert/strict';
import test from 'node:test';
import { GET as legacyGet } from '../../../app/api/p/[handle]/operations/route.ts';
import {
  GET as v1Get,
  OPTIONS as v1Options,
} from '../../../app/api/v1/profiles/[handle]/operations/route.ts';
import { getV1ProfileOperations, type V1ProfileOperationsDeps } from './profile-operations.ts';
import { parseCursor, V1Error } from './http.ts';
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
