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
  getHomeDomain,
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
  assert.notEqual(getCliLinkDomain('link'), 'signet.dev');
  assert.ok(getCliLinkDomain('link').includes('signet.dev'));
});

// ─── Purpose binding (#622) ─────────────────────────────────────────────────

test('each purpose has its own domain', () => {
  assert.notEqual(getCliLinkDomain('link'), getCliLinkDomain('unlink'));
});

test('a link challenge round-trips for link and an unlink challenge for unlink', () => {
  const client = Keypair.random();
  const link = sign(buildCliLinkChallenge(client.publicKey(), 'testnet', 'link'), client);
  const unlink = sign(buildCliLinkChallenge(client.publicKey(), 'testnet', 'unlink'), client);
  assert.equal(verifyCliLinkChallenge(link, 'link'), client.publicKey());
  assert.equal(verifyCliLinkChallenge(unlink, 'unlink'), client.publicKey());
});

test('a link challenge fails unlink verification, and the reverse', () => {
  const client = Keypair.random();
  const link = sign(buildCliLinkChallenge(client.publicKey(), 'testnet', 'link'), client);
  const unlink = sign(buildCliLinkChallenge(client.publicKey(), 'testnet', 'unlink'), client);
  assert.throws(() => verifyCliLinkChallenge(link, 'unlink'), /home domain|InvalidChallenge/i);
  assert.throws(() => verifyCliLinkChallenge(unlink, 'link'), /home domain|InvalidChallenge/i);
});

test('a challenge without a purpose fails both', () => {
  const client = Keypair.random();
  // The pre-#622 shape: the bare `cli.<home>` domain, no purpose.
  const bare = `cli.${getHomeDomain()}`;
  const challenge = WebAuth.buildChallengeTx(
    getServerKeypair(),
    client.publicKey(),
    bare,
    300,
    getNetworkPassphrase(),
    bare,
  );
  const signed = sign(challenge, client);
  assert.throws(() => verifyCliLinkChallenge(signed, 'link'), /home domain|InvalidChallenge/i);
  assert.throws(() => verifyCliLinkChallenge(signed, 'unlink'), /home domain|InvalidChallenge/i);
});

test('buildCliLinkChallenge + client signature round-trips through verifyCliLinkChallenge', () => {
  const client = Keypair.random();
  const challenge = buildCliLinkChallenge(client.publicKey(), 'testnet', 'link');
  const signed = sign(challenge, client);

  assert.equal(verifyCliLinkChallenge(signed, 'link'), client.publicKey());
});

test('rejects a challenge with no client signature', () => {
  const client = Keypair.random();
  const challenge = buildCliLinkChallenge(client.publicKey(), 'testnet', 'link');
  assert.throws(() => verifyCliLinkChallenge(challenge, 'link'));
});

test('rejects a challenge signed by the wrong keypair', () => {
  const client = Keypair.random();
  const impostor = Keypair.random();
  const challenge = buildCliLinkChallenge(client.publicKey(), 'testnet', 'link');
  const signed = sign(challenge, impostor);

  assert.throws(() => verifyCliLinkChallenge(signed, 'link'));
});

// ─── Domain separation from web sign-in (#269) ──────────────────────────────

test('a web sign-in challenge is rejected as CLI-link proof', () => {
  const client = Keypair.random();
  const signInChallenge = buildChallenge(client.publicKey());
  const signed = sign(signInChallenge, client);

  assert.throws(() => verifyCliLinkChallenge(signed, 'link'), /home domain|InvalidChallenge/i);
});

test('a CLI-link challenge is rejected as a sign-in proof', () => {
  const client = Keypair.random();
  const linkChallenge = buildCliLinkChallenge(client.publicKey(), 'testnet', 'link');
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
  assert.throws(() => buildCliLinkChallenge(client.publicKey(), 'mainnet', 'link'), CliLinkError);
});
