import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { nativeToScVal, type Transaction } from '@stellar/stellar-sdk';
import {
  getAccount,
  normalizeAccountUpdate,
  unlinkWallet,
  linkDeployWallet,
  WalletAlreadyLinkedError,
  type WalletStore,
  type LinkWalletStore,
} from './account.ts';
import type { SimulatingServer } from './registry-read.ts';

// These tests run without DATABASE_URL, which is exactly the configuration the
// handle fallback exists for: the Identity Registry, not Postgres, is
// authoritative for the handle -> wallet binding.

const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const WALLET = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';

function configureRegistry(): void {
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID = CONTRACT_ID;
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
});

function serverReturning(retval: ReturnType<typeof nativeToScVal>): SimulatingServer {
  return {
    async simulateTransaction(_tx: Transaction) {
      return { result: { retval } };
    },
  };
}

function failingServer(): SimulatingServer {
  return {
    async simulateTransaction() {
      throw new Error('connect ECONNREFUSED');
    },
  };
}

test('getAccount resolves a claimed handle on-chain with no database', async () => {
  configureRegistry();
  const account = await getAccount(WALLET, {
    server: serverReturning(nativeToScVal('aquawolf', { type: 'string' })),
  });

  assert.equal(account.address, WALLET);
  assert.equal(account.handle, 'aquawolf');
  assert.equal(account.dbConfigured, false);
});

test('getAccount reports an on-chain-only handle as not editable', async () => {
  configureRegistry();
  const account = await getAccount(WALLET, {
    server: serverReturning(nativeToScVal('aquawolf', { type: 'string' })),
  });

  // The handle is real, but displayName/bio live in Postgres — there is
  // nothing for the profile editor to write to yet.
  assert.equal(account.editable, false);
  assert.equal(account.displayName, null);
  assert.equal(account.bio, null);
});

test('getAccount leaves the handle null for a wallet with no claim', async () => {
  configureRegistry();
  const account = await getAccount(WALLET, { server: serverReturning(nativeToScVal(null)) });
  assert.equal(account.handle, null);
});

test('getAccount leaves the handle null when the registry is unconfigured', async () => {
  const account = await getAccount(WALLET);
  assert.equal(account.handle, null);
  assert.equal(account.dbConfigured, false);
  assert.equal(account.editable, false);
});

test('getAccount degrades rather than throwing when the registry read fails', async () => {
  configureRegistry();
  const account = await getAccount(WALLET, { server: failingServer() });
  assert.equal(account.handle, null);
  assert.equal(account.address, WALLET);
});

test('normalizeAccountUpdate trims and nulls out empty presentation fields', () => {
  assert.deepEqual(normalizeAccountUpdate({ displayName: '  Ada  ', bio: '   ' }), {
    displayName: 'Ada',
    bio: null,
  });
});

test('normalizeAccountUpdate rejects an over-long bio', () => {
  assert.throws(
    () => normalizeAccountUpdate({ displayName: null, bio: 'x'.repeat(281) }),
    /280 characters or fewer/,
  );
});

// ─── linkDeployWallet ───────────────────────────────────────────────────────

type WalletRow = {
  pubkey: string;
  profileId: string;
  isPrimary: boolean;
  source: string;
  attestedAt: Date;
  indexRequestedAt: Date | null;
};

/**
 * In-memory LinkWalletStore. `findUniqueCalls` counts calls to `findUnique`
 * so the race-condition test can make the *second* call (the post-race
 * recheck) see a row the *first* call (the up-front check) didn't.
 */
function fakeLinkStore(seed: WalletRow[] = []): {
  store: LinkWalletStore;
  rows: Map<string, WalletRow>;
  findUniqueCalls: { count: number };
} {
  const rows = new Map(seed.map((r) => [r.pubkey, r]));
  const findUniqueCalls = { count: 0 };
  const store: LinkWalletStore = {
    wallet: {
      findUnique: async ({ where: { pubkey } }) => {
        findUniqueCalls.count++;
        return rows.get(pubkey) ?? null;
      },
      create: async ({ data }) => {
        if (rows.has(data.pubkey)) {
          const err = new Error('Unique constraint failed on the fields: (`pubkey`)') as Error & {
            code: string;
          };
          err.code = 'P2002';
          throw err;
        }
        const row: WalletRow = { ...data };
        rows.set(data.pubkey, row);
        return row;
      },
      update: async ({ where: { pubkey }, data }) => {
        const row = rows.get(pubkey);
        if (!row) throw new Error('no such row');
        const updated = { ...row, ...data };
        rows.set(pubkey, updated);
        return updated;
      },
    },
  };
  return { store, rows, findUniqueCalls };
}

const PUBKEY = 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD';

test('linkDeployWallet requires a configured database', async () => {
  await assert.rejects(() => linkDeployWallet('profile-1', PUBKEY, 'cli'), /database/i);
});

test('linkDeployWallet creates a new, non-primary wallet row', async () => {
  const { store, rows } = fakeLinkStore();

  const result = await linkDeployWallet('profile-1', PUBKEY, 'cli', store);

  assert.equal(result.pubkey, PUBKEY);
  assert.equal(result.isPrimary, false);
  assert.equal(result.source, 'cli');
  assert.equal(rows.size, 1);
  assert.equal(rows.get(PUBKEY)?.profileId, 'profile-1');
});

test('linkDeployWallet is idempotent: re-linking the same wallet to the same profile does not duplicate', async () => {
  const attestedAt = new Date('2026-01-01T00:00:00Z');
  const { store, rows } = fakeLinkStore([
    {
      pubkey: PUBKEY,
      profileId: 'profile-1',
      isPrimary: false,
      source: 'curated',
      attestedAt,
      indexRequestedAt: null,
    },
  ]);

  const result = await linkDeployWallet('profile-1', PUBKEY, 'cli', store);

  assert.equal(rows.size, 1, 'no duplicate row was created');
  assert.equal(result.source, 'cli', 'source is refreshed on re-link');
  assert.ok(
    new Date(result.attestedAt).getTime() >= attestedAt.getTime(),
    'attestedAt is refreshed on re-link',
  );
});

test('linkDeployWallet never sets isPrimary, even on re-link of an existing primary row', async () => {
  const { store, rows } = fakeLinkStore([
    {
      pubkey: PUBKEY,
      profileId: 'profile-1',
      isPrimary: true,
      source: 'onchain',
      attestedAt: new Date(),
      indexRequestedAt: null,
    },
  ]);

  const result = await linkDeployWallet('profile-1', PUBKEY, 'cli', store);

  assert.equal(result.isPrimary, true, 'an existing isPrimary flag is preserved, not overwritten');
  assert.equal(rows.get(PUBKEY)?.isPrimary, true);
});

test('linkDeployWallet throws a typed conflict for a wallet already linked to a different profile', async () => {
  const { store } = fakeLinkStore([
    {
      pubkey: PUBKEY,
      profileId: 'someone-elses-profile',
      isPrimary: false,
      source: 'cli',
      attestedAt: new Date(),
      indexRequestedAt: null,
    },
  ]);

  await assert.rejects(
    () => linkDeployWallet('profile-1', PUBKEY, 'cli', store),
    (err: unknown) => {
      assert.ok(err instanceof WalletAlreadyLinkedError);
      assert.equal(err.pubkey, PUBKEY);
      return true;
    },
  );
});

test('linkDeployWallet resolves a create-time race the same way as the up-front check', async () => {
  // Nobody there at the up-front check (findUnique #1 returns null), but the
  // create fails with a unique-constraint violation as if a concurrent write
  // won the race — the post-race recheck (findUnique #2) is what must decide
  // idempotent-success vs. typed-conflict, matching the up-front-check path.
  const { store, rows, findUniqueCalls } = fakeLinkStore();
  const originalFindUnique = store.wallet.findUnique;
  store.wallet.findUnique = async (args) => {
    if (findUniqueCalls.count === 0) {
      findUniqueCalls.count++;
      return null;
    }
    return originalFindUnique(args);
  };
  // Seed the "concurrent write" only after the first (empty) check.
  rows.set(PUBKEY, {
    pubkey: PUBKEY,
    profileId: 'profile-1',
    isPrimary: false,
    source: 'onchain',
    attestedAt: new Date('2026-01-01T00:00:00Z'),
    indexRequestedAt: null,
  });

  const result = await linkDeployWallet('profile-1', PUBKEY, 'cli', store);

  assert.equal(result.source, 'cli', 'the race resolved to an idempotent update, not a duplicate');
  assert.equal(rows.size, 1);
});

test('linkDeployWallet resolves a create-time race as a typed conflict when the racing profile differs', async () => {
  const { store, rows, findUniqueCalls } = fakeLinkStore();
  const originalFindUnique = store.wallet.findUnique;
  store.wallet.findUnique = async (args) => {
    if (findUniqueCalls.count === 0) {
      findUniqueCalls.count++;
      return null;
    }
    return originalFindUnique(args);
  };
  rows.set(PUBKEY, {
    pubkey: PUBKEY,
    profileId: 'someone-elses-profile',
    isPrimary: false,
    source: 'onchain',
    attestedAt: new Date(),
    indexRequestedAt: null,
  });

  await assert.rejects(
    () => linkDeployWallet('profile-1', PUBKEY, 'cli', store),
    WalletAlreadyLinkedError,
  );
});

// ─── indexRequestedAt / indexingPending (#281) ──────────────────────────────

test('linking a new wallet requests indexing', async () => {
  const { store, rows } = fakeLinkStore();

  const result = await linkDeployWallet('profile-1', PUBKEY, 'cli', store);

  assert.equal(result.indexingPending, true);
  assert.ok(rows.get(PUBKEY)?.indexRequestedAt, 'indexRequestedAt is set on the row');
});

test('re-linking an already-indexed wallet requests indexing again', async () => {
  const { store, rows } = fakeLinkStore([
    {
      pubkey: PUBKEY,
      profileId: 'profile-1',
      isPrimary: false,
      source: 'curated',
      attestedAt: new Date('2026-01-01'),
      indexRequestedAt: null, // the indexer already scanned it since the last link
    },
  ]);

  const result = await linkDeployWallet('profile-1', PUBKEY, 'cli', store);

  assert.equal(result.indexingPending, true, 'a repeated link re-requests indexing');
  assert.ok(rows.get(PUBKEY)?.indexRequestedAt);
});
