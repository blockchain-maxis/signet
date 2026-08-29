import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  issueSession,
  readSession,
  verifySession,
  createChallenge,
  verifyChallenge,
  redeemChallenge,
  verifySignature,
} from './auth.ts';
import { __resetNonceStore, setNonceStore } from './nonce-store.ts';
import {
  __resetRevocationStore,
  isRevoked,
  revokeAddress,
  revokeSession,
  setRevocationStore,
} from './session-revocation.ts';

test('session token round-trips to its address', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  assert.equal(await verifySession(token), 'GWALLET');
});

test('tampered or garbage session is rejected', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  const [data] = token.split('.');
  assert.equal(await verifySession(`${data}.deadbeef`), null);
  assert.equal(await verifySession('not-a-token'), null);
  assert.equal(await verifySession(undefined), null);
});

test('sessions issued before valid-after are revoked', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  assert.equal(await verifySession(token), 'GWALLET');
  process.env.SIGNET_SESSIONS_VALID_AFTER = String(Date.now() + 1000);
  try {
    assert.equal(await verifySession(token), null);
  } finally {
    delete process.env.SIGNET_SESSIONS_VALID_AFTER;
  }
});

test('every session carries a distinct session id', () => {
  const a = readSession(issueSession('GWALLET'));
  const b = readSession(issueSession('GWALLET'));
  assert.ok(a?.sid && b?.sid, 'expected session ids');
  assert.notEqual(a!.sid, b!.sid);
});

// ── Targeted revocation ───────────────────────────────────────────────────

test('revoking one address leaves every other address signed in', async () => {
  __resetRevocationStore();
  const compromised = issueSession('GCOMPROMISED');
  const bystander = issueSession('GBYSTANDER');

  await revokeAddress('GCOMPROMISED', { until: Date.now() + 60_000 });

  assert.equal(await verifySession(compromised), null);
  // The regression this guards: the only revocation lever used to be global,
  // so responding to one compromised wallet signed out every user.
  assert.equal(await verifySession(bystander), 'GBYSTANDER');
});

test('sign out other devices keeps the calling session alive', async () => {
  __resetRevocationStore();
  const here = issueSession('GWALLET');
  const elsewhere = issueSession('GWALLET');
  const sid = readSession(here)!.sid;

  await revokeAddress('GWALLET', { exceptSid: sid, until: Date.now() + 60_000 });

  assert.equal(await verifySession(here), 'GWALLET');
  assert.equal(await verifySession(elsewhere), null);
});

test('a session issued after the cut-off survives the revocation', async () => {
  __resetRevocationStore();
  const before = issueSession('GWALLET');
  await revokeAddress('GWALLET', { until: Date.now() + 60_000 });
  assert.equal(await verifySession(before), null);

  // Signing back in has to work, or address revocation would be a permanent ban.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await verifySession(issueSession('GWALLET')), 'GWALLET');
});

test('revoking one session leaves the other sessions of that address alone', async () => {
  __resetRevocationStore();
  const laptop = issueSession('GWALLET');
  const phone = issueSession('GWALLET');

  await revokeSession(readSession(laptop)!.sid!, readSession(laptop)!.exp);

  assert.equal(await verifySession(laptop), null);
  assert.equal(await verifySession(phone), 'GWALLET');
});

test('an expired revocation entry stops rejecting sessions', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  // `until` in the past: the entry is already meaningless and is pruned on the
  // next snapshot, so the list cannot grow without bound.
  await revokeAddress('GWALLET', { until: Date.now() - 1 });
  assert.equal(await verifySession(token), 'GWALLET');
});

test('a revocation list that cannot be read fails closed', async () => {
  // Opposite of the rate limiter, same as the nonce store: an unreadable
  // revocation list must not silently mean "nobody is revoked".
  const token = issueSession('GWALLET');
  setRevocationStore({
    async put() {},
    async snapshot() {
      return null;
    },
  });
  try {
    assert.equal(await verifySession(token), null);
    assert.equal(await isRevoked({ address: 'GWALLET', iat: Date.now(), exp: Date.now() + 1000 }), true);
  } finally {
    __resetRevocationStore();
  }
});

test('a session predating session ids is covered by an address revocation', async () => {
  __resetRevocationStore();
  const legacy = { address: 'GWALLET', iat: Date.now() - 1000, exp: Date.now() + 60_000 };
  assert.equal(await isRevoked(legacy), false);
  await revokeAddress('GWALLET', { until: Date.now() + 60_000 });
  assert.equal(await isRevoked(legacy), true);
});

test('challenge verifies and is bound to the address', () => {
  const msg = createChallenge('GWALLET');
  assert.ok(verifyChallenge('GWALLET', msg));
  assert.ok(!verifyChallenge('GOTHER', msg));
});

test('tampered challenge (forged nonce) is rejected', () => {
  const forged = createChallenge('GWALLET').replace(/Nonce: \w+/, 'Nonce: 0000');
  assert.ok(!verifyChallenge('GWALLET', forged));
});

// ── redeemChallenge: single-use redemption ────────────────────────────────

/** A wallet, its challenge, and a genuine signature over it. */
function signedChallenge() {
  const kp = Keypair.random();
  const address = kp.publicKey();
  const message = createChallenge(address);
  const signature = kp.sign(Buffer.from(message, 'utf8')).toString('base64');
  return { kp, address, message, signature };
}

test('a correctly-signed challenge is redeemed once and then spent', async () => {
  __resetNonceStore();
  const { address, message, signature } = signedChallenge();

  assert.equal(await redeemChallenge(address, message, signature), 'ok');
  // The regression this guards: replaying the identical message + signature
  // used to mint a fresh session for the whole 5-minute TTL.
  assert.equal(await redeemChallenge(address, message, signature), 'replayed');
});

test('a bad signature does NOT spend the challenge', async () => {
  __resetNonceStore();
  const { address, message, signature } = signedChallenge();
  const attacker = Keypair.random();

  // Anyone can see a challenge — it is handed to the client in the clear. If a
  // junk signature spent it, they could lock the real owner out of a sign-in
  // already in progress.
  assert.equal(
    await redeemChallenge(address, message, attacker.sign(Buffer.from(message, 'utf8')).toString('base64')),
    'bad-signature',
  );
  assert.equal(await redeemChallenge(address, message, signature), 'ok');
});

test('an unissued or expired challenge is rejected before any signature work', async () => {
  __resetNonceStore();
  const { address, signature } = signedChallenge();
  const forged = createChallenge(address).replace(/Nonce: \w+/, 'Nonce: 0000');
  assert.equal(await redeemChallenge(address, forged, signature), 'invalid-challenge');
});

test('distinct challenges for the same address can each be redeemed', async () => {
  __resetNonceStore();
  const kp = Keypair.random();
  const address = kp.publicKey();
  const redeem = async () => {
    const message = createChallenge(address);
    return redeemChallenge(address, message, kp.sign(Buffer.from(message, 'utf8')).toString('base64'));
  };
  // The nonce is single-use, not the address — signing in twice must work.
  assert.equal(await redeem(), 'ok');
  assert.equal(await redeem(), 'ok');
});

test('a nonce store that cannot confirm freshness fails closed', async () => {
  // Opposite of the rate limiter: unavailable must mean "refuse", not "allow".
  const { address, message, signature } = signedChallenge();
  setNonceStore({
    async consume() {
      return false;
    },
  });
  try {
    assert.equal(await redeemChallenge(address, message, signature), 'replayed');
  } finally {
    __resetNonceStore();
  }
});

test('verifySignature accepts a genuine signature and rejects a bad one', async () => {
  const kp = Keypair.random();
  const address = kp.publicKey();
  const message = createChallenge(address);
  const goodSig = kp.sign(Buffer.from(message, 'utf8')).toString('base64');

  assert.equal(await verifySignature(address, message, goodSig), true);
  assert.equal(
    await verifySignature(address, message, Buffer.from('wrong').toString('base64')),
    false,
  );
  // A signature from a different key must not validate.
  const otherSig = Keypair.random().sign(Buffer.from(message)).toString('base64');
  assert.equal(await verifySignature(address, message, otherSig), false);
});
