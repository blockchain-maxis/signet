import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@stellar/stellar-sdk';
import {
  issueSession,
  verifySession,
  createChallenge,
  verifyChallenge,
  redeemChallenge,
  verifySignature,
} from './auth.ts';
import { __resetNonceStore, setNonceStore } from './nonce-store.ts';

test('session token round-trips to its address', () => {
  const token = issueSession('GWALLET');
  assert.equal(verifySession(token), 'GWALLET');
});

test('tampered or garbage session is rejected', () => {
  const token = issueSession('GWALLET');
  const [data] = token.split('.');
  assert.equal(verifySession(`${data}.deadbeef`), null);
  assert.equal(verifySession('not-a-token'), null);
  assert.equal(verifySession(undefined), null);
});

test('sessions issued before valid-after are revoked', () => {
  const token = issueSession('GWALLET');
  assert.equal(verifySession(token), 'GWALLET');
  process.env.SIGNET_SESSIONS_VALID_AFTER = String(Date.now() + 1000);
  try {
    assert.equal(verifySession(token), null);
  } finally {
    delete process.env.SIGNET_SESSIONS_VALID_AFTER;
  }
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
