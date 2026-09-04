import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import { buildChallenge, getNetworkPassphrase } from '../sep10.ts';
import { __resetNonceStore } from '../nonce-store.ts';
import { unlinkByChallenge, type UnlinkStore } from './cli-unlink.ts';

process.env.SEP10_SIGNING_SECRET = Keypair.random().secret();
process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'signet.dev';
process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'testnet';
process.env.DATABASE_URL = 'postgres://test';

interface Row {
  profileId: string;
  isPrimary: boolean;
}

function fakeStore(seed: Record<string, Row> = {}) {
  const wallets = new Map<string, Row>(Object.entries(seed));
  const store: UnlinkStore = {
    wallet: {
      findUnique: async ({ where }) => wallets.get(where.pubkey) ?? null,
      delete: async ({ where }) => {
        wallets.delete(where.pubkey);
        return {};
      },
    },
    profile: {
      findUnique: async ({ where }) => ({ handle: `handle-for-${where.id}` }),
    },
  };
  return { store, wallets };
}

/** Build and sign a fresh SEP-10 challenge for `client`, as the CLI would. */
function signedChallenge(client: Keypair): string {
  const challenge = buildChallenge(client.publicKey());
  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(client);
  return tx.toEnvelope().toXDR('base64');
}

test('unlinkByChallenge removes a linked non-primary wallet', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store, wallets } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: false },
  });

  const result = await unlinkByChallenge(signedChallenge(client), store);
  assert.deepEqual(result, {
    ok: true,
    pubkey: client.publicKey(),
    handle: 'handle-for-profile_1',
  });
  assert.equal(wallets.has(client.publicKey()), false);
});

test('unlinkByChallenge refuses an unsigned challenge and removes nothing', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store, wallets } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: false },
  });

  const result = await unlinkByChallenge(buildChallenge(client.publicKey()), store);
  assert.deepEqual(result, { ok: false, reason: 'bad-challenge' });
  assert.equal(wallets.has(client.publicKey()), true);
});

test('unlinkByChallenge refuses a challenge signed by the wrong key', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const owner = Keypair.random();
  const attacker = Keypair.random();
  const { store, wallets } = fakeStore({
    [owner.publicKey()]: { profileId: 'profile_1', isPrimary: false },
  });

  // The attacker signs a challenge minted for their own account; it proves
  // control of *their* key, which unlinks nothing of the owner's.
  const result = await unlinkByChallenge(signedChallenge(attacker), store);
  assert.deepEqual(result, { ok: false, reason: 'not-linked' });
  assert.equal(wallets.has(owner.publicKey()), true);
});

test('unlinkByChallenge refuses the primary wallet', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store, wallets } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: true },
  });

  const result = await unlinkByChallenge(signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'primary-wallet' });
  assert.equal(wallets.has(client.publicKey()), true);
});

test('unlinkByChallenge reports not-linked for a wallet no profile holds', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store } = fakeStore();

  const result = await unlinkByChallenge(signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'not-linked' });
});

test('unlinkByChallenge rejects a replayed challenge', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: false },
  });
  const challenge = signedChallenge(client);

  assert.equal((await unlinkByChallenge(challenge, store)).ok, true);
  assert.deepEqual(await unlinkByChallenge(challenge, store), {
    ok: false,
    reason: 'replayed',
  });
});

test('a failed signature does not spend the challenge', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: false },
  });

  // Anyone who merely sees the challenge could otherwise burn it.
  await unlinkByChallenge(buildChallenge(client.publicKey()), store);
  assert.equal((await unlinkByChallenge(signedChallenge(client), store)).ok, true);
});
