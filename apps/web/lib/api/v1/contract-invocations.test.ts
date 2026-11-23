import assert from 'node:assert/strict';
import test from 'node:test';
import { StrKey } from '@stellar/stellar-sdk';
import { contractInvocationsHandler, INVOCATIONS_CACHE_CONTROL } from './contract-invocations.ts';
import { NOT_ATTRIBUTED_MESSAGE } from './profile-contract.ts';
import { expectMatchesSchema } from './test-utils.ts';

const WALLET = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const OTHER_WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));
const TX = 'ea7a9098e63e588d81bb3aeff8c09fe2d82767228ae99a04f3039de915e753a2';

const mockInvocations = [
  {
    id: 'inv-3',
    contractId: 'c1',
    txHash: TX,
    ledger: 1003,
    createdAt: new Date('2026-10-03T12:00:00.000Z'),
    sourceAccount: WALLET,
    function: 'swap',
    successful: true,
  },
  {
    id: 'inv-2',
    contractId: 'c1',
    txHash: TX,
    ledger: 1002,
    createdAt: new Date('2026-10-02T12:00:00.000Z'),
    sourceAccount: OTHER_WALLET,
    function: 'deposit',
    successful: true,
  },
  {
    id: 'inv-1',
    contractId: 'c1',
    txHash: TX,
    ledger: 1001,
    createdAt: new Date('2026-10-01T12:00:00.000Z'),
    sourceAccount: WALLET,
    function: 'init',
    successful: true,
  },
];

function makeDb(invocations = mockInvocations) {
  return {
    contract: {
      findUnique: async ({ where }: any) => {
        if (where.address === CONTRACT) {
          return {
            id: 'c1',
            address: CONTRACT,
            wallet: { profile: { wallets: [{ pubkey: WALLET }] } },
          };
        }
        return null;
      },
    },
    contractSnapshot: {
      findFirst: async () => ({
        countedSince: new Date('2026-01-01T00:00:00.000Z'),
        totalIsFloor: true,
      }),
    },
    profile: {
      findUnique: async ({ where }: any) => {
        if (where.handle === 'alice') {
          return {
            handle: 'alice',
            wallets: [{ pubkey: WALLET }],
          };
        }
        return null;
      },
    },
    contractInvocation: {
      findMany: async ({ where, take }: any) => {
        let list = invocations.filter((inv) => inv.contractId === 'c1');
        if (where.sourceAccount?.in) {
          list = list.filter((inv) => where.sourceAccount.in.includes(inv.sourceAccount));
        }
        if (where.OR) {
          const [ltDate, eqDateLtId] = where.OR;
          const cursorDate = ltDate.createdAt.lt;
          const cursorId = eqDateLtId.id.lt;
          list = list.filter(
            (inv) =>
              inv.createdAt < cursorDate ||
              (inv.createdAt.getTime() === cursorDate.getTime() && inv.id < cursorId),
          );
        }
        return list.slice(0, take);
      },
      count: async ({ where }: any) => {
        let list = invocations.filter((inv) => inv.contractId === 'c1');
        if (where.sourceAccount?.in) {
          list = list.filter((inv) => where.sourceAccount.in.includes(inv.sourceAccount));
        }
        return list.length;
      },
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
  search = '',
  deps: { prisma?: any; attribute?: any } = { prisma: makeDb(), attribute: mockAttribute },
) {
  const handler = contractInvocationsHandler(deps);
  const url = `http://localhost/api/v1/profiles/${handle}/contracts/${address}/invocations${search ? `?${search}` : ''}`;
  return handler(new Request(url), {
    params: Promise.resolve({ handle, address }),
  });
}

test('returns 200 with invocations, keyset cursor, and meta matching schema', async () => {
  const res = await get('alice', CONTRACT, 'limit=2');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), INVOCATIONS_CACHE_CONTROL);
  const body = await res.clone().json();
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].txHash, TX);
  assert.equal(body.data[0].function, 'swap');
  assert.equal(body.meta.total, 3);
  assert.equal(body.meta.source, 'database');
  assert.equal(body.meta.totalIsFloor, true);
  assert.ok(body.meta.nextCursor);
  await expectMatchesSchema(res, 'getContractInvocations', 200);

  // Follow the cursor
  const res2 = await get('alice', CONTRACT, `limit=2&cursor=${body.meta.nextCursor}`);
  assert.equal(res2.status, 200);
  const body2 = await res2.clone().json();
  assert.equal(body2.data.length, 1);
  assert.equal(body2.data[0].function, 'init');
  assert.equal(body2.meta.nextCursor, null);
  await expectMatchesSchema(res2, 'getContractInvocations', 200);
});

test('mine=true filters to only invocations called by the handle wallets', async () => {
  const res = await get('alice', CONTRACT, 'mine=true');
  assert.equal(res.status, 200);
  const body = await res.clone().json();
  assert.equal(body.data.length, 2);
  assert.ok(body.data.every((inv: any) => inv.sourceAccount === WALLET));
  assert.equal(body.meta.total, 2);
  await expectMatchesSchema(res, 'getContractInvocations', 200);
});

test('unattributed contract returns identical 404 body as contract endpoint', async () => {
  const theirs = await get('alice', OTHER_CONTRACT);
  assert.equal(theirs.status, 404);
  const body = await theirs.clone().json();
  assert.deepEqual(body, {
    error: { code: 'not_found', message: NOT_ATTRIBUTED_MESSAGE },
  });
  await expectMatchesSchema(theirs, 'getContractInvocations', 404);
});

test('invalid contract ID or handle returns 400', async () => {
  const badAddress = await get('alice', 'not-a-contract');
  assert.equal(badAddress.status, 400);
  await expectMatchesSchema(badAddress, 'getContractInvocations', 400);

  const badHandle = await get('Invalid Handle!', CONTRACT);
  assert.equal(badHandle.status, 400);
  await expectMatchesSchema(badHandle, 'getContractInvocations', 400);
});

test('without database returns data: [] and meta.source: "none"', async () => {
  const orig = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const res = await get('alice', CONTRACT, '', { attribute: mockAttribute, prisma: null });
    assert.equal(res.status, 200);
    const body = await res.clone().json();
    assert.deepEqual(body, {
      data: [],
      meta: {
        nextCursor: null,
        total: null,
        source: 'none',
        countedSince: null,
        totalIsFloor: false,
      },
    });
    await expectMatchesSchema(res, 'getContractInvocations', 200);
  } finally {
    if (orig !== undefined) process.env.DATABASE_URL = orig;
  }
});
