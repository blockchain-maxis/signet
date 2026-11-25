import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidHandle,
  getProfile,
  getProfileWithDeps,
  getOperations,
  getPagedOperations,
  listHandles,
  listAllHandles,
  safeChainHandles,
  safeChainProfile,
  decodeResolvedAddress,
  computeStats,
  getProfileStats,
  resolveProfileStats,
  safeDbProfileStats,
  getOperationsResult,
  formatCount,
  getOperationsRetentionDays,
  formatStatsWindow,
  safeDbProfile,
  safeDbHandles,
  safeDbOperationsResult,
  liveProfileWhere,
  type ProfilesDb,
} from './profiles.ts';

test('isValidHandle accepts the registry charset', () => {
  for (const h of ['alice', 'dev_01', 'a-b-c', 'x'.repeat(32)]) {
    assert.ok(isValidHandle(h), `expected ${h} valid`);
  }
});

test('isValidHandle rejects malformed handles', () => {
  for (const h of ['', 'Aqua', 'has space', 'bad!', 'x'.repeat(33), 'em@il']) {
    assert.ok(!isValidHandle(h), `expected ${h} invalid`);
  }
});

test('getProfile rejects invalid handles without filesystem access', async () => {
  assert.equal(await getProfile('../../etc/passwd'), null);
});

test('getProfile misses when neither a DB nor a registry is configured', async () => {
  // No DATABASE_URL and no REGISTRY_CONTRACT_ID here, so both the database and
  // chain layers no-op. There is no static fallback: nothing is invented.
  assert.equal(await getProfile('alice'), null);
});

test('safeChainProfile is a no-op when the registry is not configured', async () => {
  // Returns without any network access — an unconfigured registry must not
  // cost a doomed RPC round trip on every profile render.
  assert.equal(await safeChainProfile('alice'), null);
});

test('safeChainProfile rejects invalid handles before any network access', async () => {
  assert.equal(await safeChainProfile('../../etc/passwd'), null);
});

test('decodeResolvedAddress accepts account and contract addresses', () => {
  const account = `G${'A'.repeat(55)}`;
  const contract = `C${'A'.repeat(55)}`;
  assert.equal(decodeResolvedAddress(account), account);
  assert.equal(decodeResolvedAddress(contract), contract);
});

test('decodeResolvedAddress rejects an unbound handle and malformed values', () => {
  // `resolve` returns Option<Address>; `None` decodes to null.
  assert.equal(decodeResolvedAddress(null), null);
  assert.equal(decodeResolvedAddress(undefined), null);
  assert.equal(decodeResolvedAddress(''), null);
  assert.equal(decodeResolvedAddress(`G${'A'.repeat(54)}`), null);
  assert.equal(decodeResolvedAddress(`X${'A'.repeat(55)}`), null);
  assert.equal(decodeResolvedAddress({ wallet: `G${'A'.repeat(55)}` }), null);
});

test('listAllHandles is empty when neither a DB nor a registry is configured', async () => {
  // Both real sources degrade to [] on their own, and there is no curated
  // manifest to fall back to.
  assert.deepEqual(await listAllHandles(), []);
});

test('listHandles is the same DB ∪ chain set as listAllHandles', async () => {
  const [all, handles] = await Promise.all([listAllHandles(), listHandles()]);
  assert.deepEqual(handles, all);
});

test('safeChainHandles is a no-op when the registry is not configured', async () => {
  // Must not cost an RPC round trip on every sitemap build.
  assert.deepEqual(await safeChainHandles(), []);
});

test('computeStats returns zeroed stats for missing or empty operations', () => {
  assert.deepEqual(computeStats(undefined), { invocations: 0, uniqueFunctions: 0, reputation: 0 });
  assert.deepEqual(computeStats([]), { invocations: 0, uniqueFunctions: 0, reputation: 0 });
});

test('computeStats scores successful invocations and unique function diversity', () => {
  const ops = [
    {
      id: '1',
      type: 'invoke',
      function: 'mint',
      created_at: '2026-08-30T00:00:00Z',
      transaction_successful: true,
    },
    {
      id: '2',
      type: 'invoke',
      function: 'transfer',
      created_at: '2026-08-30T01:00:00Z',
      transaction_successful: true,
    },
    {
      id: '3',
      type: 'invoke',
      function: 'transfer',
      created_at: '2026-08-30T02:00:00Z',
      transaction_successful: false,
    },
  ];
  const stats = computeStats(ops);
  assert.equal(stats.invocations, 2);
  assert.equal(stats.uniqueFunctions, 2);
  assert.equal(stats.reputation, 2 * 6 + 2 * 10);
});

test('getOperations returns an array (possibly empty) for any handle', async () => {
  assert.ok(Array.isArray(await getOperations('alice')));
  assert.deepEqual(await getOperations('does-not-exist'), []);
});

test('formatCount only claims a total when the record is complete', () => {
  assert.equal(formatCount(412, false), '412');
  // A capped read supports "at least 412", never "412".
  assert.equal(formatCount(412, true), '412+');
  assert.equal(formatCount(0, true), '0+');
});

test('profile stats expose the configured Operation retention window', () => {
  const previous = process.env.INDEXER_OPERATIONS_RETENTION_DAYS;
  try {
    delete process.env.INDEXER_OPERATIONS_RETENTION_DAYS;
    assert.equal(getOperationsRetentionDays(), 90);
    assert.equal(formatStatsWindow(getOperationsRetentionDays()), 'last 90 days');

    process.env.INDEXER_OPERATIONS_RETENTION_DAYS = '30';
    assert.equal(getOperationsRetentionDays(), 30);
    assert.equal(formatStatsWindow(getOperationsRetentionDays()), 'last 30 days');

    process.env.INDEXER_OPERATIONS_RETENTION_DAYS = '0';
    assert.equal(getOperationsRetentionDays(), 0);
    assert.equal(formatStatsWindow(null), null);
  } finally {
    if (previous === undefined) delete process.env.INDEXER_OPERATIONS_RETENTION_DAYS;
    else process.env.INDEXER_OPERATIONS_RETENTION_DAYS = previous;
  }
});

test('invalid Operation retention settings fall back to the documented default', () => {
  const previous = process.env.INDEXER_OPERATIONS_RETENTION_DAYS;
  try {
    process.env.INDEXER_OPERATIONS_RETENTION_DAYS = 'not-a-number';
    assert.equal(getOperationsRetentionDays(), 90);

    process.env.INDEXER_OPERATIONS_RETENTION_DAYS = '-1';
    assert.equal(getOperationsRetentionDays(), 90);
  } finally {
    if (previous === undefined) delete process.env.INDEXER_OPERATIONS_RETENTION_DAYS;
    else process.env.INDEXER_OPERATIONS_RETENTION_DAYS = previous;
  }
});

const RETAINED_OP = {
  id: '1',
  type: 'invoke',
  function: 'mint',
  created_at: '2026-08-30T00:00:00Z',
  transaction_successful: true,
};

test('resolveProfileStats labels a database aggregate with the retention window', () => {
  const db = { invocations: 5, uniqueFunctions: 2, reputation: 12 };
  assert.deepEqual(resolveProfileStats(db, [], 90), {
    ...db,
    exact: true,
    retentionWindowDays: 90,
  });
  // Pruning disabled: the aggregate covers the whole indexed history.
  assert.equal(resolveProfileStats(db, [], 0).retentionWindowDays, null);
});

test('resolveProfileStats keeps a genuine zero, labelled, when nothing is retained', () => {
  const zero = { invocations: 0, uniqueFunctions: 0, reputation: 0 };
  assert.deepEqual(resolveProfileStats(zero, [], 90), {
    ...zero,
    exact: true,
    retentionWindowDays: 90,
  });
});

test('resolveProfileStats prefers served operations over a zero aggregate for an unindexed profile', () => {
  const zero = { invocations: 0, uniqueFunctions: 0, reputation: 0 };
  const result = resolveProfileStats(zero, [RETAINED_OP], 90);
  assert.equal(result.invocations, 1);
  assert.equal(result.exact, false);
  assert.equal(result.retentionWindowDays, null);
});

test('resolveProfileStats computes from operations when there is no database aggregate', () => {
  const result = resolveProfileStats(null, [RETAINED_OP], 90);
  assert.equal(result.invocations, 1);
  assert.equal(result.exact, false);
  assert.equal(result.retentionWindowDays, null);
});

test('getOperationsResult has no static fallback without a DB or a bound wallet', async () => {
  // No DATABASE_URL and no registry: the DB misses, no profile resolves a
  // wallet for Horizon to read, and nothing else is consulted.
  assert.deepEqual(await getOperationsResult('alice'), {
    operations: [],
    source: 'none',
    truncated: false,
    cap: null,
  });
});

test('getOperationsResult is empty and complete for an unknown handle', async () => {
  assert.deepEqual(await getOperationsResult('does-not-exist'), {
    operations: [],
    source: 'none',
    truncated: false,
    cap: null,
  });
});

test('getOperations still returns a bare array of operations', async () => {
  const [bare, result] = await Promise.all([getOperations('alice'), getOperationsResult('alice')]);
  assert.deepEqual(bare, result.operations);
});

test('getPagedOperations is a no-op without a DATABASE_URL', async () => {
  // No DATABASE_URL configured in this test environment, so the DB layer
  // must no-op rather than throwing, letting the route fall back cleanly.
  assert.equal(await getPagedOperations('alice', 0, 25), null);
});

test('getPagedOperations rejects invalid handles without a DB round trip', async () => {
  assert.equal(await getPagedOperations('../../etc/passwd', 0, 25), null);
});

test('getProfileStats falls back to the in-memory compute without a database', async () => {
  // No DATABASE_URL in this environment, so the aggregate path must no-op and
  // the stats must come from the operations the caller already holds.
  assert.equal(await safeDbProfileStats('aquawolf'), null);
  const operations = await getOperations('aquawolf');
  const stats = await getProfileStats('aquawolf', operations);
  assert.deepEqual(
    {
      invocations: stats.invocations,
      uniqueFunctions: stats.uniqueFunctions,
      reputation: stats.reputation,
    },
    computeStats(operations),
  );
  // Not exact: derived from a window, so callers must label it as a lower bound.
  assert.equal(stats.exact, false);
  assert.ok(stats.reputation >= 0 && stats.reputation <= 100);
});

test('getProfileStats loads its own operations when none are supplied', async () => {
  const stats = await getProfileStats('aquawolf');
  assert.equal(typeof stats.invocations, 'number');
  assert.equal(typeof stats.uniqueFunctions, 'number');
  assert.ok(stats.reputation >= 0 && stats.reputation <= 100);
});

test('safeDbProfileStats rejects invalid handles without a DB round trip', async () => {
  assert.equal(await safeDbProfileStats('../../etc/passwd'), null);
});

/**
 * A stub `ProfilesDb` over in-memory rows. It applies the shared
 * `liveProfileWhere` fragment the Prisma reads use, so the released-handle rule
 * is exercised without Postgres. `alice` is what a `released`/`revoked` event
 * leaves behind: the Profile row and a CLI-linked deploy wallet, no on-chain
 * primary. `bob` still has one.
 */
type FakeWallet = { id: string; pubkey: string; isPrimary: boolean; source: string };
type FakeProfile = {
  handle: string;
  displayName?: string | null;
  bio?: string | null;
  createdAt?: Date;
  wallets: FakeWallet[];
};

const ALICE_CLI_WALLET = `G${'A'.repeat(55)}`;
const BOB_ONCHAIN_WALLET = `G${'B'.repeat(55)}`;

function onChainPrimary(profile: FakeProfile): FakeWallet | undefined {
  const { wallets } = liveProfileWhere(profile.handle);
  return profile.wallets.find(
    (w) => w.isPrimary === wallets.some.isPrimary && w.source === wallets.some.source,
  );
}

function stubProfilesDb(profiles: FakeProfile[]): ProfilesDb {
  const live = (handle: string) => {
    const { handle: normalized } = liveProfileWhere(handle);
    const profile = profiles.find((p) => p.handle === normalized);
    return profile && onChainPrimary(profile) ? profile : null;
  };
  return {
    findProfile: async (handle) => {
      const profile = live(handle);
      if (!profile) return null;
      return {
        name: profile.displayName ?? profile.handle,
        wallet: onChainPrimary(profile)!.pubkey,
        bio: profile.bio ?? '',
        joined: (profile.createdAt ?? new Date('2026-01-01T00:00:00Z')).toISOString().slice(0, 10),
        source: 'database',
      };
    },
    listHandles: async () => profiles.filter((p) => onChainPrimary(p)).map((p) => p.handle),
    findOperations: async (handle) =>
      live(handle) ? { operations: [], truncated: false, cap: null } : null,
    findPagedOperations: async (handle) => (live(handle) ? { data: [], total: 0 } : null),
    findStats: async (handle) =>
      live(handle) ? { invocations: 0, uniqueFunctions: 0, reputation: 0 } : null,
  };
}

const stubDb = stubProfilesDb([
  {
    handle: 'alice',
    displayName: 'Alice',
    bio: 'impersonator',
    wallets: [{ id: 'w1', pubkey: ALICE_CLI_WALLET, isPrimary: true, source: 'cli' }],
  },
  {
    handle: 'bob',
    displayName: 'Bob',
    bio: 'builder',
    createdAt: new Date('2026-01-02T00:00:00Z'),
    wallets: [
      { id: 'w2', pubkey: BOB_ONCHAIN_WALLET, isPrimary: true, source: 'onchain' },
      { id: 'w3', pubkey: `G${'C'.repeat(55)}`, isPrimary: false, source: 'cli' },
    ],
  },
]);

test('a profile with only CLI-linked wallets is not returned', async () => {
  // A release deletes only the on-chain primary wallet row; the leftovers must
  // not render, so the lookup misses and `getProfile` falls through to chain.
  assert.equal(await safeDbProfile('alice', stubDb), null);
  assert.equal(await getProfileWithDeps('alice', { db: stubDb }), null);
});

test('a profile with an on-chain primary is unchanged', async () => {
  assert.deepEqual(await safeDbProfile('bob', stubDb), {
    name: 'Bob',
    wallet: BOB_ONCHAIN_WALLET,
    bio: 'builder',
    joined: '2026-01-02',
    source: 'database',
  });
});

test('a profile with only CLI-linked wallets is not listed, paged, or aggregated', async () => {
  // The sitemap reads listAllHandles, which unions the live database handles
  // with live chain bindings (unconfigured here, so empty).
  assert.deepEqual(await listAllHandles(stubDb), ['bob']);
  assert.deepEqual(await safeDbHandles(stubDb), ['bob']);
  assert.equal(await safeDbOperationsResult('alice', stubDb), null);
  assert.equal(await getPagedOperations('alice', 0, 25, stubDb), null);
  assert.equal(await safeDbProfileStats('alice', stubDb), null);

  // The same reads still answer for a live profile.
  assert.deepEqual(await safeDbOperationsResult('bob', stubDb), {
    operations: [],
    truncated: false,
    cap: null,
  });
  assert.deepEqual(await getPagedOperations('bob', 0, 25, stubDb), { data: [], total: 0 });
  assert.deepEqual(await safeDbProfileStats('bob', stubDb), {
    invocations: 0,
    uniqueFunctions: 0,
    reputation: 0,
  });
});
