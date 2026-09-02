import { WebAuth } from '@stellar/stellar-sdk';
import { isMainnetNetwork } from './network-guard.ts';
import {
  getHomeDomain,
  getNetworkPassphrase,
  getServerKeypair,
  Sep10ConfigError,
  Sep10Error,
} from './sep10.ts';

/**
 * SEP-10-shaped challenge for the CLI's `signet link` — a separate purpose
 * from web sign-in (`sep10.ts` / `/api/auth/sep10`), so a signature captured
 * from one context is never valid proof for the other.
 *
 * A SEP-10 challenge's `home_domain` Manage Data operation *is* the spec's
 * own domain-separation mechanism: `WebAuth.readChallengeTx` rejects a
 * challenge whose home domain doesn't match what the verifier expects. Using
 * a distinct home domain here — rather than reusing `sep10.ts`'s — is what
 * makes a web sign-in challenge fail CLI-link verification, and a CLI-link
 * challenge fail sign-in verification, with no extra bookkeeping: the SDK
 * enforces it as part of reading the transaction.
 *
 * The network passphrase is likewise a required argument to both building and
 * verifying the challenge (it's baked into the transaction's network ID hash),
 * so a challenge built for one network cannot be replayed as proof against a
 * deployment configured for the other — see `assertNetworkMatches`, which
 * rejects the *request* itself before a challenge naming the wrong network is
 * ever built.
 */

const CLI_LINK_TIMEOUT_SECONDS = 5 * 60;

/**
 * The distinguishing home domain for CLI-link challenges — deliberately
 * different from `sep10.ts`'s `getHomeDomain()`/`getWebAuthDomain()`, which
 * back web sign-in. Not expected to resolve in DNS; SEP-10's domain check
 * here is a string match, not a lookup.
 */
export function getCliLinkDomain(): string {
  return `cli.${getHomeDomain()}`;
}

/** The Stellar network this deployment is configured for (e.g. `"testnet"`). */
export function getConfiguredNetwork(): string {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet';
}

export class CliLinkError extends Error {}

/**
 * Reject a CLI-requested network that doesn't match this deployment's
 * configured one, naming both — a testnet deploy key linked under a mainnet
 * profile would present worthless testnet contracts as real career history.
 */
export function assertNetworkMatches(requestedNetwork: string): void {
  const configured = getConfiguredNetwork();
  if (isMainnetNetwork(requestedNetwork) !== isMainnetNetwork(configured)) {
    throw new CliLinkError(
      `Network mismatch: the CLI requested "${requestedNetwork}" but this deployment is configured for "${configured}".`,
    );
  }
}

/**
 * Build a CLI-link challenge transaction for `clientAccountId` (the deploy
 * wallet's public key), after checking `requestedNetwork` against this
 * deployment's configured network.
 */
export function buildCliLinkChallenge(clientAccountId: string, requestedNetwork: string): string {
  assertNetworkMatches(requestedNetwork);
  const domain = getCliLinkDomain();
  return WebAuth.buildChallengeTx(
    getServerKeypair(),
    clientAccountId,
    domain,
    CLI_LINK_TIMEOUT_SECONDS,
    getNetworkPassphrase(),
    domain,
  );
}

/**
 * Verify a signed CLI-link challenge transaction and return the authenticated
 * client account id (the deploy wallet). Throws `Sep10Error` (or a
 * `WebAuth.InvalidChallengeError`) on any failure — including a challenge
 * built for web sign-in instead of CLI linking, since its home domain won't
 * match `getCliLinkDomain()`.
 */
export function verifyCliLinkChallenge(transactionXdr: string): string {
  const domain = getCliLinkDomain();
  const serverAccountId = getServerKeypair().publicKey();
  const { clientAccountID } = WebAuth.readChallengeTx(
    transactionXdr,
    serverAccountId,
    getNetworkPassphrase(),
    domain,
    domain,
  );
  const signers = WebAuth.verifyChallengeTxSigners(
    transactionXdr,
    serverAccountId,
    getNetworkPassphrase(),
    [clientAccountID],
    domain,
    domain,
  );
  if (!signers.includes(clientAccountID)) {
    throw new Sep10Error('Challenge was not signed by the client account');
  }
  return clientAccountID;
}

export { Sep10ConfigError as CliLinkConfigError };
