import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import { buildChallenge, getNetworkPassphrase } from '../sep10.ts';
import { __resetNonceStore } from '../nonce-store.ts';
import {
  startPairing,
  pollPairing,
  approvePairing,
  rejectPairing,
  completePairing,
  describePairing,
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
  publicKey: string | null;
  pollTokenHash: string | null;
  handoffHash: string | null;
  profileId: string | null;
  expiresAt: Date;
}
interface FakeWallet {
  pubkey: string;
  profileId: string;
}

/** In-memory stand-in for the two Prisma tables `pairing.ts` touches. */
function fakeStore(): {
  store: PairingStore;
  pairings: Map<string, FakeRow>;
  wallets: Map<string, FakeWallet>;
} {
  const pairings = new Map<string, FakeRow>();
  const wallets = new Map<string, FakeWallet>();
  let seq = 0;

  const store: PairingStore = {
    pairingState: {
      create: async ({ data }) => {
        const id = `pairing_${++seq}`;
        pairings.set(id, {
          id,
          status: 'pending',
          network: data.network,
          publicKey: data.publicKey ?? null,
          pollTokenHash: data.pollTokenHash ?? null,
          handoffHash: null,
          profileId: null,
          expiresAt: data.expiresAt,
        });
        return { id };
      },
      findUnique: async ({ where }) => {
        if ('pollTokenHash' in where) {
          for (const row of pairings.values()) {
            if (row.pollTokenHash === where.pollTokenHash) return row;
          }
          return null;
        }
        return pairings.get(where.id) ?? null;
      },
      updateMany: async ({ where, data }) => {
        const row = pairings.get(where.id);
        if (!row) return { count: 0 };
        if (row.status !== where.status) return { count: 0 };
        if (where.expiresAt && row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    profile: {
      findUnique: async ({ where }) => ({ handle: `handle-for-${where.id}` }),
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
  const pairing = await startPairing('testnet', null, store);
  assert.ok(pairing);
  const row = pairings.get(pairing!.state);
  assert.equal(row?.status, 'pending');
  assert.equal(row?.network, 'testnet');
});

// ── approvePairing ───────────────────────────────────────────────────────

test('approvePairing fails with no-profile when the address has no bound wallet', async () => {
  const { store } = fakeStore();
  const { state } = (await startPairing('testnet', null, store))!;
  assert.equal((await approvePairing(state, 'GADDRESSNOTBOUND', store)).outcome, 'no-profile');
});

test("approvePairing succeeds and records the address's profile", async () => {
  const { store, wallets, pairings } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', null, store))!;

  assert.equal((await approvePairing(state, 'GOWNER', store)).outcome, 'ok');
  assert.equal(pairings.get(state)?.status, 'approved');
  assert.equal(pairings.get(state)?.profileId, 'profile_1');
});

test('approvePairing reports not-found for an unknown state', async () => {
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  assert.equal((await approvePairing('does-not-exist', 'GOWNER', store)).outcome, 'not-found');
});

test('approvePairing reports expired for a pairing past its TTL', async () => {
  const { store, wallets, pairings } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', null, store))!;
  pairings.get(state)!.expiresAt = new Date(Date.now() - 1000);

  assert.equal((await approvePairing(state, 'GOWNER', store)).outcome, 'expired');
});

test('approvePairing reports already-used for a pairing that is not pending', async () => {
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', null, store))!;
  await approvePairing(state, 'GOWNER', store);

  assert.equal((await approvePairing(state, 'GOWNER', store)).outcome, 'already-used');
});

// ── completePairing ──────────────────────────────────────────────────────

async function approvedPairing(
  store: PairingStore,
  wallets: Map<string, FakeWallet>,
  network = getNetworkPassphrase(),
) {
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing(network, null, store))!;
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
  const { state } = (await startPairing(getNetworkPassphrase(), null, store))!;
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
  assert.deepEqual(result, {
    ok: true,
    wallet: { pubkey: client.publicKey(), profileId: 'profile_1' },
    handle: 'handle-for-profile_1',
  });
});

// ── the declared deploy key, and the browser's view of it ────────────────

test('startPairing records the deploy key the CLI declared', async () => {
  const { store, pairings } = fakeStore();
  const client = Keypair.random();

  const { state } = (await startPairing('testnet', client.publicKey(), store))!;
  assert.equal(pairings.get(state)!.publicKey, client.publicKey());
});

test('describePairing returns the declared key for a pending pairing', async () => {
  const { store } = fakeStore();
  const client = Keypair.random();
  const { state } = (await startPairing('testnet', client.publicKey(), store))!;

  const view = await describePairing(state, store);
  assert.equal(view.ok, true);
  assert.equal(view.ok && view.publicKey, client.publicKey());
});

test('describePairing refuses an unknown code', async () => {
  const { store } = fakeStore();
  assert.deepEqual(await describePairing('does-not-exist', store), {
    ok: false,
    reason: 'not-found',
  });
});

test('describePairing refuses an expired code', async () => {
  const { store, pairings } = fakeStore();
  const { state } = (await startPairing('testnet', null, store))!;
  pairings.get(state)!.expiresAt = new Date(Date.now() - 1000);

  assert.deepEqual(await describePairing(state, store), { ok: false, reason: 'expired' });
});

test('describePairing refuses a pairing that was already answered', async () => {
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);

  assert.deepEqual(await describePairing(state, store), { ok: false, reason: 'already-used' });
});

test('describePairing never discloses which profile approved', async () => {
  const { store, wallets } = fakeStore();
  const { state } = (await startPairing('testnet', 'GDECLARED', store))!;
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });

  const view = await describePairing(state, store);
  assert.equal(view.ok, true);
  assert.deepEqual(Object.keys(view).sort(), ['expiresAt', 'ok', 'publicKey', 'state']);
});

// ── reject ───────────────────────────────────────────────────────────────

test('rejectPairing moves a pending pairing to rejected', async () => {
  const { store, pairings } = fakeStore();
  const { state } = (await startPairing('testnet', null, store))!;

  assert.equal(await rejectPairing(state, store), 'ok');
  assert.equal(pairings.get(state)!.status, 'rejected');
});

test('rejectPairing reports not-found for an unknown state', async () => {
  const { store } = fakeStore();
  assert.equal(await rejectPairing('does-not-exist', store), 'not-found');
});

test('rejectPairing reports expired for a pairing past its TTL', async () => {
  const { store, pairings } = fakeStore();
  const { state } = (await startPairing('testnet', null, store))!;
  pairings.get(state)!.expiresAt = new Date(Date.now() - 1000);

  assert.equal(await rejectPairing(state, store), 'expired');
});

test('rejectPairing reports already-used for a pairing that was approved', async () => {
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);

  assert.equal(await rejectPairing(state, store), 'already-used');
});

test('a rejected pairing cannot then be approved', async () => {
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', null, store))!;

  assert.equal(await rejectPairing(state, store), 'ok');
  assert.equal((await approvePairing(state, 'GOWNER', store)).outcome, 'already-used');
});

// ── the approved key is the key that gets bound ──────────────────────────

test('completePairing refuses a challenge signed by a key other than the declared one', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets, pairings } = fakeStore();
  const declared = Keypair.random();
  const other = Keypair.random();

  const state = await approvedPairing(store, wallets);
  pairings.get(state)!.publicKey = declared.publicKey();

  const result = await completePairing(state, signedChallenge(other), store);
  assert.deepEqual(result, { ok: false, reason: 'key-mismatch' });
  assert.equal(wallets.has(other.publicKey()), false);
});

test('completePairing accepts the declared key', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets, pairings } = fakeStore();
  const declared = Keypair.random();

  const state = await approvedPairing(store, wallets);
  pairings.get(state)!.publicKey = declared.publicKey();

  const result = await completePairing(state, signedChallenge(declared), store);
  assert.deepEqual(result, {
    ok: true,
    wallet: { pubkey: declared.publicKey(), profileId: 'profile_1' },
    handle: 'handle-for-profile_1',
  });
});

// ── the polling fallback (#273) ──────────────────────────────────────────

test('startPairing returns a poll token that is not the pairing code', async () => {
  const { store, pairings } = fakeStore();
  const started = (await startPairing('testnet', null, store))!;

  assert.ok(started.pollToken.length >= 32);
  assert.notEqual(started.pollToken, started.state);
  assert.notEqual(pairings.get(started.state)!.pollTokenHash, started.pollToken);
});

test('pollPairing reports pending for a fresh pairing', async () => {
  const { store } = fakeStore();
  const { pollToken } = (await startPairing('testnet', null, store))!;

  assert.deepEqual(await pollPairing(pollToken, store), { ok: true, status: 'pending' });
});

test('pollPairing reports approved once the browser approves', async () => {
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state, pollToken } = (await startPairing('testnet', null, store))!;
  await approvePairing(state, 'GOWNER', store);

  assert.deepEqual(await pollPairing(pollToken, store), { ok: true, status: 'approved' });
});

test('pollPairing reports rejected once the browser refuses', async () => {
  const { store } = fakeStore();
  const { state, pollToken } = (await startPairing('testnet', null, store))!;
  await rejectPairing(state, store);

  assert.deepEqual(await pollPairing(pollToken, store), { ok: true, status: 'rejected' });
});

test('pollPairing reports expired for a pending pairing past its TTL', async () => {
  const { store, pairings } = fakeStore();
  const { state, pollToken } = (await startPairing('testnet', null, store))!;
  pairings.get(state)!.expiresAt = new Date(Date.now() - 1000);

  assert.deepEqual(await pollPairing(pollToken, store), { ok: true, status: 'expired' });
});

test('pollPairing does not accept the pairing code in place of the poll token', async () => {
  const { store } = fakeStore();
  const { state } = (await startPairing('testnet', null, store))!;

  assert.deepEqual(await pollPairing(state, store), { ok: false, reason: 'not-found' });
});

test('pollPairing reports not-found for an unknown token', async () => {
  const { store } = fakeStore();
  assert.deepEqual(await pollPairing('nope', store), { ok: false, reason: 'not-found' });
});

// ── the manual handoff code ──────────────────────────────────────────────

test('approvePairing returns a handoff code the browser can show', async () => {
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing('testnet', null, store))!;

  const result = await approvePairing(state, 'GOWNER', store);
  assert.equal(result.outcome, 'ok');
  assert.match(result.outcome === 'ok' ? result.handoffCode : '', /^[0-9A-HJKMNP-TV-Z]{8}$/);
});

test('completePairing accepts the handoff code the browser showed', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  wallets.set('GOWNER', { pubkey: 'GOWNER', profileId: 'profile_1' });
  const { state } = (await startPairing(getNetworkPassphrase(), null, store))!;
  const approved = await approvePairing(state, 'GOWNER', store);
  const handoff = approved.outcome === 'ok' ? approved.handoffCode : '';
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store, handoff);
  assert.equal(result.ok, true);
});

test('completePairing refuses a wrong handoff code', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store, 'WRONGCOD');
  assert.deepEqual(result, { ok: false, reason: 'bad-handoff' });
  assert.equal(wallets.has(client.publicKey()), false);
});

test('completePairing does not require a handoff code on the loopback path', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.equal(result.ok, true);
});

// ── adversarial coverage for the pairing trust boundary (#291) ───────────
//
// Every failure mode of `completePairing` is a security property rather than a
// UX detail, and the comment at `../auth.ts:99-120` records that this codebase
// has already been bitten once by exactly this class of bug. These are the
// cases from #291 that were not already covered above.

/**
 * A challenge minted and signed by somebody *else's* server — the shape an
 * attacker who stands up their own SEP-10 endpoint would produce.
 */
function foreignChallenge(client: Keypair, server: Keypair, homeDomain = 'signet.dev'): string {
  return WebAuth.buildChallengeTx(
    server,
    client.publicKey(),
    homeDomain,
    300,
    getNetworkPassphrase(),
    homeDomain,
  );
}

function signForeign(client: Keypair, server: Keypair, homeDomain?: string): string {
  const challenge = foreignChallenge(client, server, homeDomain);
  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(client);
  return tx.toEnvelope().toXDR('base64');
}

test('completePairing refuses a challenge minted by a different server', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();
  const attackerServer = Keypair.random();

  // Correctly signed by the client — but the challenge is not ours, so the
  // server-side signature check is the only thing standing between an
  // attacker's own endpoint and a wallet binding here.
  const result = await completePairing(state, signForeign(client, attackerServer), store);
  assert.deepEqual(result, { ok: false, reason: 'bad-challenge' });
  assert.equal(wallets.has(client.publicKey()), false);
});

test('completePairing refuses a challenge scoped to a different domain', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const state = await approvedPairing(store, wallets);
  const client = Keypair.random();
  const attackerServer = Keypair.random();

  // Domain separation: a challenge issued for some other site must not be
  // redeemable here even if every signature on it is valid.
  const result = await completePairing(
    state,
    signForeign(client, attackerServer, 'evil.example'),
    store,
  );
  assert.deepEqual(result, { ok: false, reason: 'bad-challenge' });
  assert.equal(wallets.has(client.publicKey()), false);
});

test('a signed challenge for one pairing cannot complete a different pairing', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const first = await approvedPairing(store, wallets);
  const second = await approvedPairing(store, wallets);
  const client = Keypair.random();
  const challenge = signedChallenge(client);

  assert.equal((await completePairing(first, challenge, store)).ok, true);

  // The same envelope against the other pairing: single-use accounting is
  // what stops one signature being spent twice, under any state.
  const result = await completePairing(second, challenge, store);
  assert.deepEqual(result, { ok: false, reason: 'replayed' });
});

test('completePairing refuses a pairing the browser never approved', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  // Minted but never approved: the CLI holds a valid signature for a real
  // deploy key, which proves key control and nothing about handle ownership.
  const { state } = (await startPairing(getNetworkPassphrase(), null, store))!;
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'not-approved' });
  assert.equal(wallets.has(client.publicKey()), false);
});

test('a rejected pairing cannot be completed', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets } = fakeStore();
  const { state } = (await startPairing(getNetworkPassphrase(), null, store))!;
  await rejectPairing(state, store);
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.equal(result.ok, false);
  assert.equal(wallets.has(client.publicKey()), false);
});

test('an expired pairing cannot be completed even with a valid signature', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const { store, wallets, pairings } = fakeStore();
  const state = await approvedPairing(store, wallets);
  pairings.get(state)!.expiresAt = new Date(Date.now() - 1000);
  const client = Keypair.random();

  const result = await completePairing(state, signedChallenge(client), store);
  assert.deepEqual(result, { ok: false, reason: 'expired' });
  assert.equal(wallets.has(client.publicKey()), false);
});
