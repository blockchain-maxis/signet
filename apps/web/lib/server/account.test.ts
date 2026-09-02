import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { nativeToScVal, type Transaction } from '@stellar/stellar-sdk';
import { getAccount, normalizeAccountUpdate, unlinkWallet, type WalletStore } from './account.ts';
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

// ─── unlinkWallet ───────────────────────────────────────────────────────────

/** In-memory WalletStore backed by a plain map, keyed by pubkey. */
function fakeWalletStore(rows: Record<string, { profileId: string; isPrimary: boolean }>): {
  store: WalletStore;
  deleted: string[];
} {
  const deleted: string[] = [];
  const store: WalletStore = {
    wallet: {
      findUnique: async ({ where: { pubkey } }) => rows[pubkey] ?? null,
      delete: async ({ where: { pubkey } }) => {
        deleted.push(pubkey);
      },
    },
  };
  return { store, deleted };
}

test('unlinkWallet requires a configured database', async () => {
  await assert.rejects(() => unlinkWallet(WALLET, 'GOTHER'), /database/i);
});

test('unlinkWallet refuses a caller with no profile of their own', async () => {
  const { store } = fakeWalletStore({});
  await assert.rejects(() => unlinkWallet(WALLET, 'GOTHER', store), /No profile is bound/);
});

test('unlinkWallet refuses a wallet that does not exist', async () => {
  const { store } = fakeWalletStore({
    [WALLET]: { profileId: 'p1', isPrimary: true },
  });
  await assert.rejects(() => unlinkWallet(WALLET, 'GMISSING', store), /not found/i);
});

test('unlinkWallet refuses a wallet bound to a different profile', async () => {
  const { store, deleted } = fakeWalletStore({
    [WALLET]: { profileId: 'p1', isPrimary: true },
    GOTHERSPROFILE: { profileId: 'p2', isPrimary: false },
  });
  // Same "not found" message as a nonexistent pubkey — the caller must not be
  // able to tell "doesn't exist" from "belongs to someone else".
  await assert.rejects(() => unlinkWallet(WALLET, 'GOTHERSPROFILE', store), /not found/i);
  assert.equal(deleted.length, 0);
});

test('unlinkWallet refuses the primary wallet', async () => {
  const { store, deleted } = fakeWalletStore({
    [WALLET]: { profileId: 'p1', isPrimary: true },
  });
  await assert.rejects(() => unlinkWallet(WALLET, WALLET, store), /primary/i);
  assert.equal(deleted.length, 0);
});

test("unlinkWallet deletes a non-primary wallet on the caller's own profile", async () => {
  const { store, deleted } = fakeWalletStore({
    [WALLET]: { profileId: 'p1', isPrimary: true },
    GSECOND: { profileId: 'p1', isPrimary: false },
  });
  await unlinkWallet(WALLET, 'GSECOND', store);
  assert.deepEqual(deleted, ['GSECOND']);
});
