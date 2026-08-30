import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { buildChallenge, getNetworkPassphrase } from '../sep10.ts';
import { __resetNonceStore } from '../nonce-store.ts';
import {
  startPairing,
  approvePairing,
  completePairing,
  type PairingStore,
} from './pairing.ts';

// `getServerKeypair()` (inside sep10.ts) caches on first call, so this must be
// set before anything here touches it, directly or via `buildChallenge`.
process.env.SEP10_SIGNING_SECRET = Keypair.random().secret();
process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'signet.dev';
process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'testnet';

interface FakeRow {
  id: string;
  status: string;
  network: string;
  profileId: string | null;
  expiresAt: Date;
}
interface FakeWallet {
  pubkey: string;
  profileId: string;
}

/** In-memory stand-in for the two Prisma tables `pairing.ts` touches. */
function fakeStore(): { store: PairingStore; pairings: Map<string, FakeRow>; wallets: Map<string, FakeWallet> } {
  const pairings = new Map<string, FakeRow>();
  const wallets = new Map<string, FakeWallet>();
  let seq = 0;

  const store: PairingStore = {
    pairingState: {
      create: async ({ data }) => {
        const id = `pairing_${++seq}`;
        pairings.set(id, { id, status: 'pending', network: data.network, profileId: null, expiresAt: data.expiresAt });
        return { id };
      },
      findUnique: async ({ where }) => pairings.get(where.id) ?? null,
      updateMany: async ({ where, data }) => {
        const row = pairings.get(where.id);
        if (!row) return { count: 0 };
        if (row.status !== where.status) return { count: 0 };
        if (where.expiresAt && row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    wallet: {
      findUnique: async ({ where }) => wallets.get(where.pubkey) ?? null,
      create: async ({ data }) => {
        const row: FakeWallet = { pubkey: data.pubkey, profileId: data.profileId };
        wallets.set(data.pubkey, row);
        return row;
      },
    },
    $transaction: async (fn) => fn(store),
  };

  return { store, pairings, wallets };
}

/** Build and sign a fresh SEP-10 challenge for `client`. */
function signedChallenge(client: Keypair): string {
  const challenge = buildChallenge(client.publicKey());
  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(client);
  return tx.toEnvelope().toXDR('base64');
}

// ── startPairing ─────────────────────────────────────────────────────────

test('startPairing returns null when no database is configured', async () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(await startPairing('testnet'), null);
});

test('startPairing mints a pending pairing with the given network', async () => {
  const { store, pairings } = fakeStore();
  const pairing = await startPairing('testnet', store);
  assert.ok(pairing);
  const row = pairings.get(pairing!.state);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.network, 'testnet');
});

// ── approvePairing ───────────────────────────────────────────────────────

test('approvePairing fails with no-profile when the address has no bound wallet', async () => {
  const { store } = fakeStore();
  const { state } = (await startPairing('testnet', store))!;
  assert.equal(await approvePairing(state, 'GADDRESSNOTBOUND', store), 'no-profile');
});

test('approvePairing succeeds and records the address\'s profile', async () => {
  const { store, wallets, pairings } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', store))!;

  assert.equal(await approvePairing(state, 'GOWNER', store), 'ok');
  assert.equal(pairings.get(state)?.status, 'approved');
  assert.equal(pairings.get(state)?.profileId, 'profile_1');
});

test('approvePairing reports not-found for an unknown state', async () => {
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  assert.equal(await approvePairing('does-not-exist', 'GOWNER', store), 'not-found');
});

test('approvePairing reports expired for a pairing past its TTL', async () => {
  const { store, wallets, pairings } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', store))!;
  pairings.get(state)!.expiresAt = new Date(Date.now() - 1000);

  assert.equal(await approvePairing(state, 'GOWNER', store), 'expired');
});

test('approvePairing reports already-used for a pairing that is not pending', async () => {
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', store))!;
  await approvePairing(state, 'GOWNER', store);

  assert.equal(await approvePairing(state, 'GOWNER', store), 'already-used');
});

// ── completePairing ──────────────────────────────────────────────────────

async function approvedPairing(store: PairingStore, wallets: Map<string, FakeWallet>, network = getNetworkPassphrase()) {
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing(network, store))!;
  await approvePairing(state, 'GOWNER', store);
  return state;
}

test('completePairing reports not-found for an unknown state', async () => {
  const { store } = fakeStore();
  const client = Keypair.random();
  const result = await completePairing('does-not-exist', signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'not-found' });
});

test('completePairing reports not-approved when the pairing is still pending', async () => {
  const { store } = fakeStore();
  const { state } = (await startPairing(getNetworkPassphrase(), store))!;
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'not-approved' });
});

test('completePairing reports expired when the pairing outlived its TTL', async () => {
  const { store, wallets, pairings } = fakeStore();
  const state = await approvedPairing(store, wallets);
  pairings.get(state)!.expiresAt = new Date(Date.now() - 1000);
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'expired' });
});

test('completePairing reports network-mismatch when the pairing was started for a different network', async () => {
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets, 'Some Other Network ; 2026');
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'network-mismatch' });
});

test('completePairing reports bad-challenge for an unsigned challenge', async () => {
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();
  const unsigned = buildChallenge(client.publicKey()); // server-signed only

  const result = await completePairing(state, unsigned, store);
  assert.deepEqual(result, { ok: false, reason: 'bad-challenge' });
});

test('completePairing reports bad-challenge for a challenge signed by the wrong key', async () => {
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();
  const impostor = Keypair.random();
  const challenge = buildChallenge(client.publicKey());
  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(impostor);

  const result = await completePairing(state, tx.toEnvelope().toXDR('base64'), store);
  assert.deepEqual(result, { ok: false, reason: 'bad-challenge' });
});

test('completePairing succeeds and writes a cli, non-primary wallet', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.wallet.pubkey, client.publicKey());
  assert.equal(result.wallet.profileId, 'profile_1');

  const written = wallets.get(client.publicKey());
  assert.ok(written);
});

test('completePairing reports already-completed on a second completion attempt', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();

  const first = await completePairing(state, signedChallenge(client), store);
  assert.equal(first.ok, true);

  // A distinct signed challenge (fresh nonce) against the same, now-completed
  // pairing — the pairing's own status is what must reject this, not nonce reuse.
  const second = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(second, { ok: false, reason: 'already-completed' });
});

test('completePairing rejects a replayed signed challenge (byte-identical resubmission)', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();
  const challenge = signedChallenge(client);

  const first = await completePairing(state, challenge, store);
  assert.equal(first.ok, true);

  // Start a second, freshly-approved pairing and try to spend the *same*
  // signed challenge XDR against it — the nonce, not the pairing status,
  // must be what rejects this.
  const otherState = await approvedPairing(store, wallets);
  const second = await completePairing(otherState, challenge, store);
  assert.deepEqual(second, { ok: false, reason: 'replayed' });
});

test('completePairing rejects a deploy account already bound to a different profile', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const client = Keypair.random();
  wallets.set(client.publicKey(), { pubkey: client.publicKey(), profileId: 'someone_else' });
  const state = await approvedPairing(store, wallets);

  const result = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'wallet-bound-elsewhere' });
});

test('completePairing is idempotent when the deploy account is already bound to the same profile', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const client = Keypair.random();
  const state = await approvedPairing(store, wallets); // seeds GOWNER -> profile_1
  wallets.set(client.publicKey(), { pubkey: client.publicKey(), profileId: 'profile_1' });

  const result = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(result, { ok: true, wallet: { pubkey: client.publicKey(), profileId: 'profile_1' } });
});
