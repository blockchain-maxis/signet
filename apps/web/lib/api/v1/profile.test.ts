import assert from 'node:assert/strict';
import test from 'node:test';
import { GET } from '../../../app/api/v1/profiles/[handle]/route.ts';
import type { ProfileContractsResult } from '../../profile-contracts.ts';
import type { OperationsResult, Profile, ProfileStatsResult } from '../../profiles.ts';
import { __resetRateLimit } from '../../rate-limit.ts';
import { V1Error } from './http.ts';
import { getV1Profile, type V1ProfileDeps } from './profile.ts';
import { expectMatchesSchema } from './test-utils.ts';

const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const CONTRACT = `C${'A'.repeat(55)}`;

const dbProfile: Profile = {
  name: 'Alice Smith',
  wallet: WALLET,
  bio: 'Smart contract developer',
  joined: '2026-09-01',
  source: 'database',
};
const chainProfile: Profile = {
  name: 'alice',
  wallet: WALLET,
  bio: '',
  joined: '',
  source: 'chain',
};

const ops = (
  truncated: boolean,
  source: OperationsResult['source'] = 'database',
): OperationsResult => ({
  operations: [{ id: '1', type: 'invoke_host_function', created_at: '2026-10-01T00:00:00Z' }],
  source,
  truncated,
  cap: truncated ? 100 : null,
});
const stats = (over: Partial<ProfileStatsResult> = {}): ProfileStatsResult => ({
  invocations: 7,
  uniqueFunctions: 2,
  reputation: 42,
  exact: false,
  retentionWindowDays: null,
  ...over,
});
const contracts = (n: number, truncated = false): ProfileContractsResult => ({
  contracts: Array.from({ length: n }, () => ({
    address: CONTRACT,
    deployedAt: '2026-09-02T00:00:00.000Z',
    deployTxHash: 'abc',
    deployerPubkey: WALLET,
    source: 'database' as const,
    wasmHash: null,
  })),
  source: 'database',
  truncated,
  cap: truncated ? 200 : null,
  multiWallet: false,
});

function deps(over: V1ProfileDeps): V1ProfileDeps {
  return {
    network: 'testnet',
    getProfile: async () => dbProfile,
    getOperationsResult: async () => ops(false),
    getProfileStats: async () => stats(),
    getProfileContracts: async () => contracts(2),
    countWallets: async () => 3,
    ...over,
  };
}

async function envelope(d: V1ProfileDeps) {
  const res = await getV1Profile('alice', d);
  const body = { data: res.data, meta: res.meta };
  await expectMatchesSchema(body, 'getProfile', 200);
  return body;
}

test('database path: schema-valid, with counts and display fields', async () => {
  const { data, meta } = await envelope(deps({}));
  assert.deepEqual(data, {
    handle: 'alice',
    displayName: 'Alice Smith',
    bio: 'Smart contract developer',
    primaryWallet: WALLET,
    joinedAt: '2026-09-01T00:00:00.000Z',
    network: 'testnet',
    archived: false,
    counts: { contracts: 2, wallets: 3, invocations: 7 },
    countsAreLowerBounds: false,
  });
  assert.deepEqual(meta, { network: 'testnet', source: 'database' });
});

test('v1 payload carries neither operations nor reputation', async () => {
  const { data } = await envelope(deps({}));
  for (const key of ['operations', 'reputation', 'stats']) assert.ok(!(key in data));
  assert.ok(!('reputation' in data.counts));
});

test('chain-only path: schema-valid, nulls for unknown off-chain fields', async () => {
  const { data, meta } = await envelope(
    deps({
      getProfile: async () => chainProfile,
      getOperationsResult: async () => ops(false, 'horizon'),
      getProfileContracts: async () => contracts(0),
      countWallets: async () => null,
    }),
  );
  assert.equal(data.displayName, null);
  assert.equal(data.bio, null);
  assert.equal(data.joinedAt, null);
  assert.equal(data.primaryWallet, WALLET);
  assert.equal(data.counts.wallets, 1);
  assert.equal(meta.source, 'chain');
});

test('archived chain entry with no readable wallet is schema-valid', async () => {
  const { data } = await envelope(
    deps({
      getProfile: async () => ({ ...chainProfile, wallet: '', archived: true }),
      countWallets: async () => null,
    }),
  );
  assert.equal(data.archived, true);
  assert.equal(data.primaryWallet, null);
  assert.equal(data.counts.wallets, 0);
});

test('a truncated operations read sets countsAreLowerBounds', async () => {
  const { data } = await envelope(deps({ getOperationsResult: async () => ops(true) }));
  assert.equal(data.countsAreLowerBounds, true);
});

test('truncated contracts or a retention-windowed aggregate set countsAreLowerBounds', async () => {
  const a = await envelope(deps({ getProfileContracts: async () => contracts(1, true) }));
  assert.equal(a.data.countsAreLowerBounds, true);
  const b = await envelope(
    deps({ getProfileStats: async () => stats({ exact: true, retentionWindowDays: 90 }) }),
  );
  assert.equal(b.data.countsAreLowerBounds, true);
});

test('an exact, unwindowed aggregate is not a lower bound even if the read was capped', async () => {
  const { data } = await envelope(
    deps({
      getOperationsResult: async () => ops(true),
      getProfileStats: async () => stats({ exact: true, retentionWindowDays: null }),
    }),
  );
  assert.equal(data.countsAreLowerBounds, false);
});

test('unknown handle throws not_found', async () => {
  await assert.rejects(
    getV1Profile('nobody', deps({ getProfile: async () => null })),
    (err: unknown) => err instanceof V1Error && err.code === 'not_found',
  );
});

const call = (handle: string) =>
  GET(new Request(`http://localhost/api/v1/profiles/${handle}`), {
    params: Promise.resolve({ handle }),
  });

test('route: bad handle → 400 bad_request, schema-valid error', async () => {
  __resetRateLimit();
  for (const bad of ['Bad Handle!', 'x'.repeat(33), '..%2Fetc']) {
    const res = await call(bad);
    assert.equal(res.status, 400, bad);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await expectMatchesSchema(res, 'getProfile', 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_request');
  }
});

test('route: unknown handle → 404 not_found (no DB, no registry configured)', async () => {
  __resetRateLimit();
  const res = await call('nobody');
  assert.equal(res.status, 404);
  await expectMatchesSchema(res, 'getProfile', 404);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_found');
});
