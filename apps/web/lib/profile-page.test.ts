import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadProfilePageData } from './profile-page.ts';
import type { Profile, OperationsResult } from './profiles.ts';
import type { ProfileContractsResult } from './profile-contracts.ts';
import type { HorizonOperationsResult } from './server/horizon.ts';

test('with stubbed dependencies and no database, one page load resolves the handle once and walks Horizon once', async () => {
  let resolveCount = 0;
  let horizonCount = 0;

  const fakeProfile: Profile = {
    name: 'alice',
    wallet: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    bio: 'Builder',
    joined: '2026-01-01',
    source: 'chain',
  };

  const fakeHorizonResult: HorizonOperationsResult = {
    operations: [
      {
        id: 'op1',
        type: 'invoke_host_function',
        function: 'increment',
        source_account: fakeProfile.wallet,
        created_at: '2026-01-02T00:00:00Z',
        transaction_hash: 'tx1',
        transaction_successful: true,
      },
    ],
    truncated: false,
    cap: 400,
  };

  const data = await loadProfilePageData('alice', {
    getProfile: async () => {
      resolveCount++;
      return fakeProfile;
    },
    fetchHorizonOperations: async () => {
      horizonCount++;
      return fakeHorizonResult;
    },
  });

  assert.ok(data);
  assert.equal(resolveCount, 1, 'resolves the handle once');
  assert.equal(horizonCount, 1, 'walks Horizon once');
  assert.equal(data.operations.length, 1);
  assert.equal(data.source, 'horizon');
});

test('with a database, the operations and contracts reads start before either finishes', async () => {
  const fakeProfile: Profile = {
    name: 'alice',
    wallet: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    bio: 'Builder',
    joined: '2026-01-01',
    source: 'database',
  };

  let opsStarted = false;
  let contractsStarted = false;

  function defer<T>() {
    let resolve!: (val: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  const opsDeferred = defer<OperationsResult>();
  const contractsDeferred = defer<ProfileContractsResult>();

  const loadPromise = loadProfilePageData('alice', {
    getProfile: async () => fakeProfile,
    getOperationsResult: async () => {
      opsStarted = true;
      return opsDeferred.promise;
    },
    getProfileContracts: async () => {
      contractsStarted = true;
      return contractsDeferred.promise;
    },
    getProfileStats: async () => ({
      invocations: 5,
      uniqueFunctions: 2,
      reputation: 80,
      exact: true,
      retentionWindowDays: null,
    }),
  });

  // Spin event loop to allow Promise.all to invoke both async functions
  await new Promise((r) => setImmediate(r));

  assert.equal(opsStarted, true, 'operations read started before completion');
  assert.equal(contractsStarted, true, 'contracts read started before completion');

  opsDeferred.resolve({
    operations: [],
    source: 'database',
    truncated: false,
    cap: null,
  });
  contractsDeferred.resolve({
    contracts: [],
    source: 'database',
    truncated: false,
    cap: null,
    multiWallet: false,
  });

  const data = await loadPromise;
  assert.ok(data);
  assert.equal(data.profile.name, 'alice');
});

test('unknown handle returns null without starting operations or contracts reads', async () => {
  let opsStarted = false;
  let contractsStarted = false;

  const data = await loadProfilePageData('unknown', {
    getProfile: async () => null,
    getOperationsResult: async () => {
      opsStarted = true;
      return { operations: [], source: 'none', truncated: false, cap: null };
    },
    getProfileContracts: async () => {
      contractsStarted = true;
      return { contracts: [], source: 'none', truncated: false, cap: null, multiWallet: false };
    },
  });

  assert.equal(data, null);
  assert.equal(opsStarted, false);
  assert.equal(contractsStarted, false);
});
