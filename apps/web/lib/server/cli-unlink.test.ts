import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import { buildChallenge, getNetworkPassphrase } from '../sep10.ts';
import { buildCliLinkChallenge } from '../cli-link.ts';
import { __resetNonceStore } from '../nonce-store.ts';
import { unlinkByChallenge, type UnlinkStore } from './cli-unlink.ts';
import { logger } from '../logger.ts';
import { PAIRING_EVENTS } from '@signet/types';

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

/** Build and sign a fresh CLI-link challenge for `client`, as the CLI would. */
function signedChallenge(client: Keypair): string {
  const challenge = buildCliLinkChallenge(client.publicKey(), 'testnet');
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

  const result = await unlinkByChallenge(
    buildCliLinkChallenge(client.publicKey(), 'testnet'),
    store,
  );
  assert.deepEqual(result, { ok: false, reason: 'bad-challenge' });
  assert.equal(wallets.has(client.publicKey()), true);
});

test('unlinkByChallenge rejects a signed web sign-in challenge (wrong domain)', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store, wallets } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: false },
  });
  // A perfectly valid sign-in proof, signed by the wallet's own key: it must
  // not be able to detach the wallet.
  const signIn = TransactionBuilder.fromXDR(
    buildChallenge(client.publicKey()),
    getNetworkPassphrase(),
  );
  signIn.sign(client);

  const result = await unlinkByChallenge(signIn.toEnvelope().toXDR('base64'), store);
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
  await unlinkByChallenge(buildCliLinkChallenge(client.publicKey(), 'testnet'), store);
  assert.equal((await unlinkByChallenge(signedChallenge(client), store)).ok, true);
});

// ── audit trail (#620) ───────────────────────────────────────────────────

interface LoggedLine {
  level: 'info' | 'warn';
  msg: string;
  fields: Record<string, unknown>;
}

/** Spy on the logger for the rest of the test; returns every line it was handed. */
function captureLogs(t: TestContext): LoggedLine[] {
  const lines: LoggedLine[] = [];
  for (const level of ['info', 'warn'] as const) {
    t.mock.method(logger, level, (fields: Record<string, unknown>, msg: string) => {
      lines.push({ level, msg, fields });
    });
  }
  return lines;
}

const AUDIT_NAMES: readonly string[] = Object.values(PAIRING_EVENTS);
const auditLines = (lines: LoggedLine[]) => lines.filter((l) => AUDIT_NAMES.includes(l.msg));

test('an unlink emits pairing.unlinked, and no line carries the challenge', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: false },
  });
  const challenge = signedChallenge(client);
  const logs = captureLogs(t);

  assert.equal((await unlinkByChallenge(challenge, store)).ok, true);
  assert.deepEqual(auditLines(logs), [
    {
      level: 'info',
      msg: 'pairing.unlinked',
      fields: {
        profileId: 'profile_1',
        outcome: 'unlinked',
        source: 'cli-unlink',
        handle: 'handle-for-profile_1',
        wallet: client.publicKey(),
        reason: 'withdrawn',
      },
    },
  ]);
  assert.equal(JSON.stringify(logs).includes(challenge), false);
});

test('a refused unlink emits pairing.linkRejected with the UnlinkFailure', async (t) => {
  __resetNonceStore();
  t.after(() => __resetNonceStore());
  const client = Keypair.random();
  const { store } = fakeStore({
    [client.publicKey()]: { profileId: 'profile_1', isPrimary: true },
  });
  const challenge = signedChallenge(client);
  const logs = captureLogs(t);

  await unlinkByChallenge(challenge, store);
  assert.deepEqual(auditLines(logs), [
    {
      level: 'warn',
      msg: 'pairing.linkRejected',
      fields: {
        outcome: 'rejected',
        source: 'cli-unlink',
        wallet: client.publicKey(),
        reason: 'primary-wallet',
      },
    },
  ]);
  assert.equal(JSON.stringify(logs).includes(challenge), false);
});

test('a bad signature on unlink emits pairing.linkRejected without the challenge', async (t) => {
  const client = Keypair.random();
  const { store } = fakeStore();
  const unsigned = buildChallenge(client.publicKey());
  const logs = captureLogs(t);

  await unlinkByChallenge(unsigned, store);
  assert.deepEqual(auditLines(logs), [
    {
      level: 'warn',
      msg: 'pairing.linkRejected',
      fields: { outcome: 'rejected', source: 'cli-unlink', reason: 'bad-challenge' },
    },
  ]);
  assert.equal(JSON.stringify(logs).includes(unsigned), false);
});
