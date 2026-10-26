import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from '../../../app/api/v1/profiles/[handle]/contracts/route.ts';
import type { ProfileContractsDbRow } from '../../profile-contracts.ts';
import type { Profile } from '../../profiles.ts';
import { parseCursor, V1Error } from './http.ts';
import {
  getV1ProfileContracts,
  type V1ProfileContractsCursor,
  type V1ProfileContractsDeps,
} from './profile-contracts.ts';
import { expectMatchesSchema } from './test-utils.ts';

const WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const profile: Profile = {
  name: 'alice',
  wallet: WALLET,
  bio: '',
  joined: '2026-01-01',
  source: 'database',
};

// Contract IDs that sort in a known order: C + 55 base32 characters.
const address = (i: number) => `C${String.fromCharCode(65 + i).repeat(55)}`;

/** Seven contracts; three pairs share a deploy time, so the address breaks ties. */
function rows(): ProfileContractsDbRow[] {
  const times = [
    '2026-10-01',
    '2026-10-03',
    '2026-10-03',
    '2026-10-02',
    '2026-10-02',
    '2026-10-05',
    '2026-10-05',
  ];
  return times.map((day, i) => ({
    address: address(i),
    network: 'testnet',
    deployerPubkey: WALLET,
    deployTxHash: `${i}`.padStart(64, '0'),
    deployedAt: new Date(`${day}T00:00:00.000Z`),
    wasmHash: i % 2 ? 'ab'.repeat(32) : null,
    executableType: i === 0 ? 'stellar_asset' : 'wasm',
    walletId: 'w1',
    walletPubkey: WALLET,
  }));
}

const withDb = (contracts: ProfileContractsDbRow[]): V1ProfileContractsDeps => ({
  network: 'testnet',
  db: { listContracts: async () => ({ contracts, walletCount: 1 }) },
  getProfile: async () => profile,
});

test('three pages walk every contract once, newest first, the address breaking ties', async () => {
  const deps = withDb(rows());
  const seen: string[] = [];
  let cursor: V1ProfileContractsCursor | null = null;
  for (let page = 0; page < 3; page++) {
    const { data, meta } = await getV1ProfileContracts('alice', { cursor, limit: 3 }, deps);
    await expectMatchesSchema({ data, meta }, 'getProfileContracts', 200);
    assert.equal(meta.source, 'database');
    assert.equal(meta.total, 7);
    assert.equal(meta.truncated, false);
    seen.push(...data.map((c) => c.address));
    cursor = meta.nextCursor ? parseCursor<V1ProfileContractsCursor>(meta.nextCursor) : null;
    assert.equal(cursor === null, page === 2, `page ${page + 1} cursor`);
  }
  assert.deepEqual(seen, [5, 6, 1, 2, 3, 4, 0].map(address));
  // A contract deployed between pages does not shift what the cursor returns.
  const later = rows();
  later.push({
    ...later[0]!,
    address: address(9),
    deployedAt: new Date('2026-10-04T00:00:00.000Z'),
  });
  const first = await getV1ProfileContracts('alice', { limit: 3 }, withDb(rows()));
  const next = parseCursor<V1ProfileContractsCursor>(first.meta.nextCursor);
  const second = await getV1ProfileContracts('alice', { cursor: next, limit: 3 }, withDb(later));
  assert.deepEqual(
    second.data.map((c) => c.address),
    [2, 3, 4].map(address),
  );
});

test('a row carries the contract page fields', async () => {
  const { data } = await getV1ProfileContracts('alice', { limit: 100 }, withDb(rows()));
  const sac = data.find((c) => c.address === address(0));
  assert.deepEqual(sac, {
    address: address(0),
    deployer: WALLET,
    deployedAt: '2026-10-01T00:00:00.000Z',
    deployTxHash: '0'.padStart(64, '0'),
    network: 'testnet',
    wasmHash: null,
    contractType: 'stellar_asset',
  });
});

test('with no layer to ask, the answer says it is incomplete, not empty', async () => {
  const deps: V1ProfileContractsDeps = {
    network: 'testnet',
    db: { listContracts: async () => undefined },
    horizon: {
      boundWallet: async () => null,
      listOperations: async () => null,
      getResultMetaXdr: async () => null,
    },
    getProfile: async () => profile,
  };
  const res = await getV1ProfileContracts('alice', {}, deps);
  assert.deepEqual(res, {
    data: [],
    meta: { nextCursor: null, total: null, truncated: true, cap: null, source: 'none' },
  });
  await expectMatchesSchema(res, 'getProfileContracts', 200);

  await assert.rejects(
    getV1ProfileContracts('nobody', {}, { ...deps, getProfile: async () => null }),
    (err: unknown) => err instanceof V1Error && err.code === 'not_found',
  );
});

test('a bad handle or cursor is a 400', async () => {
  const params = (handle: string) => ({ params: Promise.resolve({ handle }) });
  const bad = await GET(
    new Request('http://localhost/api/v1/profiles/Not%20A%20Handle!/contracts'),
    params('Not A Handle!'),
  );
  assert.equal(bad.status, 400);
  await expectMatchesSchema(bad, 'getProfileContracts');
  const cursor = await GET(
    new Request('http://localhost/api/v1/profiles/alice/contracts?cursor=@@'),
    params('alice'),
  );
  assert.equal(cursor.status, 400);
});
