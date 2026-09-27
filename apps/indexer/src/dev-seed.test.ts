import assert from 'node:assert/strict';
import test from 'node:test';
import { runDevSeed, validateDevSeedEnvironment, type DevSeedStore } from './dev-seed.js';
import type { RegistryReader } from './registry-read.js';
import type { WalletSource } from '@signet/types';

function createMockStore(): {
  store: DevSeedStore;
  profiles: Map<string, { id: string; handle: string }>;
  wallets: Map<string, { pubkey: string; profileId: string; source: WalletSource; isPrimary: boolean; indexRequestedAt?: Date | null }>;
} {
  const profiles = new Map<string, { id: string; handle: string }>();
  const wallets = new Map<string, { pubkey: string; profileId: string; source: WalletSource; isPrimary: boolean; indexRequestedAt?: Date | null }>();

  const store: DevSeedStore = {
    profile: {
      async upsert({ where, create }) {
        let p = profiles.get(where.handle);
        if (!p) {
          p = { id: `prof_${where.handle}`, handle: create.handle };
          profiles.set(where.handle, p);
        }
        return { id: p.id };
      },
      async findMany() {
        return [];
      },
    },
    wallet: {
      async upsert({ where, create, update }) {
        let w = wallets.get(where.pubkey);
        if (!w) {
          w = { ...create };
          wallets.set(where.pubkey, w);
        } else {
          Object.assign(w, update);
        }
        return w;
      },
      async deleteMany({ where }) {
        if (where.pubkey) {
          wallets.delete(where.pubkey);
        }
        return { count: 1 };
      },
      async update({ where, data }) {
        const w = wallets.get(where.pubkey);
        if (!w) throw new Error(`Wallet not found: ${where.pubkey}`);
        if (data.indexRequestedAt) {
          w.indexRequestedAt = data.indexRequestedAt;
        }
        return w;
      },
    },
  };

  return { store, profiles, wallets };
}

test('resolved handle writes one profile and one wallet with indexRequestedAt set', async () => {
  const { store, profiles, wallets } = createMockStore();
  const mockReader: RegistryReader = {
    async resolveMany(handles: string[]) {
      return handles.map((h) => (h === 'alice' ? 'GBALICE12345' : null));
    },
    async count() {
      return 1;
    },
  };

  const result = await runDevSeed(
    {
      handle: 'alice',
      network: 'testnet',
      nodeEnv: 'development',
      databaseUrl: 'postgresql://signet:signet@localhost:5432/signet',
    },
    {
      store,
      reader: mockReader,
    },
  );

  assert.equal(result.handle, 'alice');
  assert.equal(result.wallet, 'GBALICE12345');

  const profile = profiles.get('alice');
  assert.ok(profile, 'profile was created');
  assert.equal(profile.handle, 'alice');

  const wallet = wallets.get('GBALICE12345');
  assert.ok(wallet, 'wallet was created');
  assert.equal(wallet.profileId, profile.id);
  assert.equal(wallet.source, 'onchain');
  assert.equal(wallet.isPrimary, true);
  assert.ok(wallet.indexRequestedAt instanceof Date, 'indexRequestedAt is set');
});

test('unresolved handle writes nothing and throws "handle not claimed on testnet"', async () => {
  const { store, profiles, wallets } = createMockStore();
  const mockReader: RegistryReader = {
    async resolveMany() {
      return [null];
    },
    async count() {
      return 0;
    },
  };

  await assert.rejects(
    async () => {
      await runDevSeed(
        {
          handle: 'bob',
          network: 'testnet',
          nodeEnv: 'development',
          databaseUrl: 'postgresql://signet:signet@localhost:5432/signet',
        },
        {
          store,
          reader: mockReader,
        },
      );
    },
    (err: Error) => {
      assert.match(err.message, /handle not claimed on testnet/);
      return true;
    },
  );

  assert.equal(profiles.size, 0, 'no profiles were written');
  assert.equal(wallets.size, 0, 'no wallets were written');
});

test('production guard rejects when NODE_ENV is production unless --i-know is passed', () => {
  assert.throws(
    () => {
      validateDevSeedEnvironment({
        handle: 'alice',
        nodeEnv: 'production',
        databaseUrl: 'postgresql://signet:signet@localhost:5432/signet',
      });
    },
    /Refusing to run dev:seed in production without --i-know/,
  );

  // With iKnow: true, it passes
  assert.doesNotThrow(() => {
    validateDevSeedEnvironment({
      handle: 'alice',
      nodeEnv: 'production',
      iKnow: true,
      databaseUrl: 'postgresql://signet:signet@localhost:5432/signet',
    });
  });
});

test('production guard rejects non-local database host unless --i-know is passed', () => {
  assert.throws(
    () => {
      validateDevSeedEnvironment({
        handle: 'alice',
        nodeEnv: 'development',
        databaseUrl: 'postgresql://user:pass@prod-db.example.com:5432/signet',
      });
    },
    /Refusing to run dev:seed against non-local database host "prod-db.example.com" without --i-know/,
  );

  // Allowed local and docker hosts
  for (const host of ['localhost', '127.0.0.1', 'postgres', 'signet-postgres', 'signet-db', 'db']) {
    assert.doesNotThrow(() => {
      validateDevSeedEnvironment({
        handle: 'alice',
        nodeEnv: 'development',
        databaseUrl: `postgresql://signet:signet@${host}:5432/signet`,
      });
    });
  }
});
