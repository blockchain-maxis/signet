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

// ── Fixed SEP-10 vectors ─────────────────────────────────────────────────
//
// The tests above build challenges with our own `buildChallenge`/`WebAuth`
// calls, so a shared misreading of the spec on both sides would still pass.
// These instead run fixed, pre-generated XDR (frozen at generation time, not
// rebuilt per run) through the SDK's `readChallengeTx`/`verifyChallengeTxSigners`
// — the same functions `verifyChallenge` wraps — against a fixed server/client
// keypair pair, independent of this module's challenge-building code.
//
// Vectors generated once via `WebAuth.buildChallengeTx` with a 100-year
// timeout (so they don't expire) for:
//   server: GC3EMCYACUVLUKBO7JCBQ5CLEA4GGLC6QPHVFNRA36WJU3XC7PGQLQ44
//   client: GB6EGXUFCFNSFFNLHCJBM22GXNZLYDBC5ZGCUHAGGXYONP4KVASNPTCA
//   home_domain / web_auth_domain: signet.dev, network: testnet

const FIXED_SERVER_PUBLIC = 'GC3EMCYACUVLUKBO7JCBQ5CLEA4GGLC6QPHVFNRA36WJU3XC7PGQLQ44';
const FIXED_CLIENT_PUBLIC = 'GB6EGXUFCFNSFFNLHCJBM22GXNZLYDBC5ZGCUHAGGXYONP4KVASNPTCA';
const FIXED_SIGNED_XDR =
  'AAAAAgAAAAC2RgsAFSq6KC76RBh0SyA4Yyxeg89StiDfrJpu4vvNBQAAAMgAAAAAAAAAAAAAAAEAAAAAanEKCAAAAAEmaSgIAAAAAAAAAAIAAAABAAAAAHxDXoURWyKVqziSFmtGu3K8DCLuTCocBjXw5r+KqCTXAAAACgAAAA9zaWduZXQuZGV2IGF1dGgAAAAAAQAAAEBEQlYzRFJEMzVqWW5YNXRTUWJ3SUlKWmhXa1JWVnp1TjJaTVZoWFhVOGdTQmxaK0hpOFAvZyt4MDN6Wi9EQkN0AAAAAQAAAAC2RgsAFSq6KC76RBh0SyA4Yyxeg89StiDfrJpu4vvNBQAAAAoAAAAPd2ViX2F1dGhfZG9tYWluAAAAAAEAAAAKc2lnbmV0LmRldgAAAAAAAAAAAALi+80FAAAAQAUvDhi+PGwR4GgGLNB7yiLia6+XflfcIsALHBLKz9nE3+njhPZWUWj/iKdErfmJNdEI6aMCpvS/lCIyBK+O8gOKqCTXAAAAQKGWOLqOJp1qT3N7CjmGjvWxIrQK3JDuEP6SjVfOWI50UgR+/8l9YmxOQZR9KT4MeJAb3kR+uduH+qxyI8jX5As=';

test('accepts a fixed known-good SEP-10 challenge transaction', () => {
  const { clientAccountID } = WebAuth.readChallengeTx(
    FIXED_SIGNED_XDR,
    FIXED_SERVER_PUBLIC,
    getNetworkPassphrase(),
    getHomeDomain(),
    getWebAuthDomain(),
  );
  assert.equal(clientAccountID, FIXED_CLIENT_PUBLIC);

  const signers = WebAuth.verifyChallengeTxSigners(
    FIXED_SIGNED_XDR,
    FIXED_SERVER_PUBLIC,
    getNetworkPassphrase(),
    [FIXED_CLIENT_PUBLIC],
    getHomeDomain(),
    getWebAuthDomain(),
  );
  assert.deepEqual(signers, [FIXED_CLIENT_PUBLIC]);
});

test('rejects the fixed vector against the wrong server key', () => {
  const impostorServer = Keypair.random().publicKey();
  assert.throws(() =>
    WebAuth.readChallengeTx(
      FIXED_SIGNED_XDR,
      impostorServer,
      getNetworkPassphrase(),
      getHomeDomain(),
      getWebAuthDomain(),
    ),
  );
});

test('rejects the fixed vector when the client signature is stripped', () => {
  // Rebuild the envelope with only the server's signature (drop the client's).
  const tx = TransactionBuilder.fromXDR(FIXED_SIGNED_XDR, getNetworkPassphrase());
  const envelope = tx.toEnvelope();
  envelope.v1().signatures().pop();
  const serverOnlyXdr = envelope.toXDR('base64');

  assert.throws(() =>
    WebAuth.verifyChallengeTxSigners(
      serverOnlyXdr,
      FIXED_SERVER_PUBLIC,
      getNetworkPassphrase(),
      [FIXED_CLIENT_PUBLIC],
      getHomeDomain(),
      getWebAuthDomain(),
    ),
  );
});
