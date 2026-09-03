import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import {
  buildCliLinkChallenge,
  verifyCliLinkChallenge,
  assertNetworkMatches,
  getConfiguredNetwork,
  getCliLinkDomain,
  CliLinkError,
} from './cli-link.ts';
import {
  buildChallenge,
  verifyChallenge,
  getServerKeypair,
  getNetworkPassphrase,
} from './sep10.ts';

// `getServerKeypair()` caches on first call, so this must be set before any
// test invokes it (directly or indirectly via the build/verify functions).
process.env.SEP10_SIGNING_SECRET = Keypair.random().secret();
process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'signet.dev';
process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'testnet';

function sign(challengeXdr: string, client: Keypair): string {
  const tx = TransactionBuilder.fromXDR(challengeXdr, getNetworkPassphrase());
  tx.sign(client);
  return tx.toEnvelope().toXDR('base64');
}

test('getCliLinkDomain differs from the web sign-in domain', () => {
  assert.notEqual(getCliLinkDomain(), 'signet.dev');
  assert.ok(getCliLinkDomain().includes('signet.dev'));
});

test('buildCliLinkChallenge + client signature round-trips through verifyCliLinkChallenge', () => {
  const client = Keypair.random();
  const challenge = buildCliLinkChallenge(client.publicKey(), 'testnet');
  const signed = sign(challenge, client);

  assert.equal(verifyCliLinkChallenge(signed), client.publicKey());
});

test('rejects a challenge with no client signature', () => {
  const client = Keypair.random();
  const challenge = buildCliLinkChallenge(client.publicKey(), 'testnet');
  assert.throws(() => verifyCliLinkChallenge(challenge));
});

test('rejects a challenge signed by the wrong keypair', () => {
  const client = Keypair.random();
  const impostor = Keypair.random();
  const challenge = buildCliLinkChallenge(client.publicKey(), 'testnet');
  const signed = sign(challenge, impostor);

  assert.throws(() => verifyCliLinkChallenge(signed));
});

// ─── Domain separation from web sign-in (#269) ──────────────────────────────

test('a web sign-in challenge is rejected as CLI-link proof', () => {
  const client = Keypair.random();
  const signInChallenge = buildChallenge(client.publicKey());
  const signed = sign(signInChallenge, client);

  assert.throws(() => verifyCliLinkChallenge(signed), /home domain|InvalidChallenge/i);
});

test('a CLI-link challenge is rejected as a sign-in proof', () => {
  const client = Keypair.random();
  const linkChallenge = buildCliLinkChallenge(client.publicKey(), 'testnet');
  const signed = sign(linkChallenge, client);

  assert.throws(() => verifyChallenge(signed), /home domain|InvalidChallenge/i);
});

test('a signed sign-in challenge still verifies fine as a sign-in proof (sanity check)', () => {
  const client = Keypair.random();
  const signInChallenge = buildChallenge(client.publicKey());
  const signed = sign(signInChallenge, client);
  assert.equal(verifyChallenge(signed), client.publicKey());
});

// ─── Network binding (#263) ─────────────────────────────────────────────────

test('assertNetworkMatches is a no-op when the requested network matches', () => {
  assert.doesNotThrow(() => assertNetworkMatches(getConfiguredNetwork()));
  assert.doesNotThrow(() => assertNetworkMatches('testnet'));
});

test('assertNetworkMatches rejects a mismatched network, naming both', () => {
  assert.throws(
    () => assertNetworkMatches('mainnet'),
    (err: unknown) => {
      assert.ok(err instanceof CliLinkError);
      assert.match((err as Error).message, /mainnet/);
      assert.match((err as Error).message, /testnet/);
      return true;
    },
  );
});

test('buildCliLinkChallenge refuses to build a challenge for a mismatched network', () => {
  const client = Keypair.random();
  assert.throws(() => buildCliLinkChallenge(client.publicKey(), 'mainnet'), CliLinkError);
});
