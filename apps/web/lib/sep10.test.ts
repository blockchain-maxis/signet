import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import {
  buildChallenge,
  verifyChallenge,
  getServerKeypair,
  getHomeDomain,
  getWebAuthDomain,
  getNetworkPassphrase,
  issueJwt,
  verifyJwt,
  Sep10Error,
} from './sep10.ts';

// `getServerKeypair()` caches on first call, so this must be set before any
// test invokes it (directly or via `buildChallenge`/`verifyChallenge`).
process.env.SEP10_SIGNING_SECRET = Keypair.random().secret();
process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'signet.dev';
process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'testnet';

test('buildChallenge + client signature round-trips through verifyChallenge', () => {
  const client = Keypair.random();
  const challenge = buildChallenge(client.publicKey());

  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(client);
  const signed = tx.toEnvelope().toXDR('base64');

  assert.equal(verifyChallenge(signed), client.publicKey());
});

test('rejects a challenge with no client signature (server-only)', () => {
  const client = Keypair.random();
  const challenge = buildChallenge(client.publicKey());
  // `challenge` is server-signed only — never touched by the client.
  assert.throws(() => verifyChallenge(challenge));
});

test('rejects a challenge signed by the wrong keypair', () => {
  const client = Keypair.random();
  const impostor = Keypair.random();
  const challenge = buildChallenge(client.publicKey());

  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(impostor); // signed by someone other than the named client account
  const signed = tx.toEnvelope().toXDR('base64');

  assert.throws(() => verifyChallenge(signed));
});

test('rejects a caller-supplied home_domain that does not match this service', () => {
  const client = Keypair.random();
  assert.throws(() => buildChallenge(client.publicKey(), 'not-our-domain.example'), Sep10Error);
});

test('rejects expired timebounds', () => {
  const client = Keypair.random();
  // Build directly with an already-elapsed timeout, bypassing our wrapper's
  // fixed 5-minute window, to exercise the SDK's timebounds check.
  const challenge = WebAuth.buildChallengeTx(
    getServerKeypair(),
    client.publicKey(),
    getHomeDomain(),
    -600, // expired 10 minutes ago
    getNetworkPassphrase(),
    getWebAuthDomain(),
  );
  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(client);
  const signed = tx.toEnvelope().toXDR('base64');

  assert.throws(() => verifyChallenge(signed), WebAuth.InvalidChallengeError);
});

test('rejects a challenge built against a different server signing key', () => {
  const otherServer = Keypair.random();
  const client = Keypair.random();
  const challenge = WebAuth.buildChallengeTx(
    otherServer,
    client.publicKey(),
    getHomeDomain(),
    300,
    getNetworkPassphrase(),
    getWebAuthDomain(),
  );
  const tx = TransactionBuilder.fromXDR(challenge, getNetworkPassphrase());
  tx.sign(client);
  const signed = tx.toEnvelope().toXDR('base64');

  // Our `verifyChallenge` always checks against *this* service's server key.
  assert.throws(() => verifyChallenge(signed));
});

test('issueJwt / verifyJwt round-trips to the client account', () => {
  const token = issueJwt('GCLIENTACCOUNT');
  assert.equal(verifyJwt(token), 'GCLIENTACCOUNT');
});

test('verifyJwt rejects a tampered signature', () => {
  const token = issueJwt('GCLIENTACCOUNT');
  const [header, payload] = token.split('.');
  assert.equal(verifyJwt(`${header}.${payload}.deadbeef`), null);
});

test('verifyJwt rejects garbage input', () => {
  assert.equal(verifyJwt('not-a-jwt'), null);
});
