import assert from 'node:assert/strict';
import test from 'node:test';
import { StrKey } from '@stellar/stellar-sdk';
import { contractVersionsHandler, VERSIONS_CACHE_CONTROL } from './contract-versions.ts';
import { NOT_ATTRIBUTED_MESSAGE } from './profile-contract.ts';
import { expectMatchesSchema } from './test-utils.ts';

const WALLET = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));
const HASH_1 = 'aa'.repeat(32);
const HASH_2 = 'bb'.repeat(32);
const HASH_3 = 'cc'.repeat(32);

function makeDb(rows: any[] = []) {
  return {
    contractWasmVersion: {
      findMany: async () => rows,
    },
  };
}

const mockAttribute = async (handle: string, address: string) => {
  if (handle.toLowerCase() === 'alice' && address === CONTRACT) {
    return { status: 'attributed' as const, wallet: WALLET, method: 'indexer' as const };
  }
  return { status: 'not-attributed' as const };
};

function get(
  handle: string,
  address: string,
  deps: { prisma?: any; attribute?: any } = { prisma: makeDb(), attribute: mockAttribute },
) {
  const handler = contractVersionsHandler(deps);
  const url = `http://localhost/api/v1/profiles/${handle}/contracts/${address}/versions`;
  return handler(new Request(url), {
    params: Promise.resolve({ handle, address }),
  });
}

test('returns 200 with versions and upgrade descriptions matching schema', async () => {
  const rows = [
    {
      wasmHash: HASH_3,
      observedAt: new Date('2026-10-03T12:00:00.000Z'),
      observedLedger: 1003,
    },
    {
      wasmHash: HASH_2,
      observedAt: new Date('2026-10-02T12:00:00.000Z'),
      observedLedger: 1002,
    },
    {
      wasmHash: HASH_1,
      observedAt: new Date('2026-10-01T12:00:00.000Z'),
      observedLedger: 1001,
    },
  ];

  const res = await get('alice', CONTRACT, { prisma: makeDb(rows), attribute: mockAttribute });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), VERSIONS_CACHE_CONTROL);
  const body = await res.clone().json();
  assert.equal(body.data.length, 3);
  assert.equal(body.data[0].wasmHash, HASH_3);
  assert.equal(body.meta.source, 'database');
  assert.equal(body.meta.detectionStartsAt, '2026-10-01T12:00:00.000Z');
  assert.ok(body.meta.windowSentence);
  assert.ok(body.meta.headerNote);
  await expectMatchesSchema(res, 'getContractVersions', 200);
});

test('handles 1 version with proper detectionStartsAt and null windowSentence', async () => {
  const rows = [
    {
      wasmHash: HASH_1,
      observedAt: new Date('2026-10-01T12:00:00.000Z'),
      observedLedger: 1001,
    },
  ];

  const res = await get('alice', CONTRACT, { prisma: makeDb(rows), attribute: mockAttribute });
  assert.equal(res.status, 200);
  const body = await res.clone().json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].wasmHash, HASH_1);
  assert.equal(body.meta.detectionStartsAt, '2026-10-01T12:00:00.000Z');
  await expectMatchesSchema(res, 'getContractVersions', 200);
});

test('handles 0 versions gracefully', async () => {
  const res = await get('alice', CONTRACT, { prisma: makeDb([]), attribute: mockAttribute });
  assert.equal(res.status, 200);
  const body = await res.clone().json();
  assert.deepEqual(body.data, []);
  assert.equal(body.meta.source, 'database');
  assert.equal(body.meta.detectionStartsAt, null);
  await expectMatchesSchema(res, 'getContractVersions', 200);
});

test('unattributed contract returns 404', async () => {
  const res = await get('alice', OTHER_CONTRACT);
  assert.equal(res.status, 404);
  const body = await res.clone().json();
  assert.deepEqual(body, {
    error: { code: 'not_found', message: NOT_ATTRIBUTED_MESSAGE },
  });
  await expectMatchesSchema(res, 'getContractVersions', 404);
});

test('without database returns data: [] and meta.source: "none"', async () => {
  const orig = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const res = await get('alice', CONTRACT, { attribute: mockAttribute, prisma: null });
    assert.equal(res.status, 200);
    const body = await res.clone().json();
    assert.deepEqual(body, {
      data: [],
      meta: {
        source: 'none',
        detectionStartsAt: null,
        windowSentence: null,
        headerNote: null,
      },
    });
    await expectMatchesSchema(res, 'getContractVersions', 200);
  } finally {
    if (orig !== undefined) process.env.DATABASE_URL = orig;
  }
});
