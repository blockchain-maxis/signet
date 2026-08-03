import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed, type SeedStore } from './seed.ts';
import { seedProfiles } from '../seed-data.ts';

/** In-memory stand-in for the Prisma tables `seed` touches, keyed the same way. */
function fakeStore(): { store: SeedStore; profiles: Map<string, any>; wallets: Map<string, any> } {
  const profiles = new Map<string, any>();
  const wallets = new Map<string, any>();

  const store: SeedStore = {
    profile: {
      upsert: async ({ where, update, create }) => {
        const existing = profiles.get(where.handle);
        const row = existing ? { ...existing, ...update } : { id: `p_${where.handle}`, ...create };
        profiles.set(where.handle, row);
        return row;
      },
    },
    wallet: {
      upsert: async ({ where, update, create }) => {
        const existing = wallets.get(where.pubkey);
        const row = existing ? { ...existing, ...update } : { ...create };
        wallets.set(where.pubkey, row);
        return row;
      },
    },
  };

  return { store, profiles, wallets };
}

test('seed populates a profile and wallet per curated entry', async () => {
  const { store, profiles, wallets } = fakeStore();
  await seed(store);

  const expectedWallets = seedProfiles.reduce((n, p) => n + p.wallets.length, 0);
  assert.equal(profiles.size, seedProfiles.length);
  assert.equal(wallets.size, expectedWallets);
});

test('reseeding is idempotent — running seed twice converges on identical state', async () => {
  const { store, profiles, wallets } = fakeStore();

  await seed(store);
  const firstProfiles = JSON.stringify([...profiles.entries()].sort());
  const firstWallets = JSON.stringify([...wallets.entries()].sort());
  const firstProfileCount = profiles.size;
  const firstWalletCount = wallets.size;

  await seed(store);

  assert.equal(profiles.size, firstProfileCount, 'reseeding must not create duplicate profiles');
  assert.equal(wallets.size, firstWalletCount, 'reseeding must not create duplicate wallets');
  assert.equal(JSON.stringify([...profiles.entries()].sort()), firstProfiles);
  assert.equal(JSON.stringify([...wallets.entries()].sort()), firstWallets);
});
