import { expect, type Page } from '@playwright/test';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

/**
 * Shared helpers for the authenticated e2e specs.
 *
 * Sign-in needs a wallet, and there is no wallet extension in a Playwright
 * browser — but there doesn't need to be. SEP-10 authenticates *key ownership*
 * (a pure ed25519 check; the account doesn't have to exist on any ledger), so
 * a `Keypair.random()` held by the test is a complete test identity.
 *
 * Two ways in, used by different specs:
 *
 *  - `apiSignIn` drives the SEP-10 endpoints directly through `page.request`,
 *    which shares the browser context's cookie jar — the session cookie set by
 *    the verify response is there for the next `page.goto`. Fast; use it when
 *    the subject under test is what's *behind* the session, not sign-in itself.
 *
 *  - `stubWallet` fakes the one hardware boundary (the extension) and nothing
 *    else: it installs a `window.rabet` whose `sign` round-trips through this
 *    Node process for a real ed25519 signature. Rabet is in the wallet kit's
 *    default modules and its API is two functions, which makes it the honest
 *    minimum to stub — the app's own kit wiring, challenge fetch, verify call
 *    and reload all run for real. Use it to test sign-in and the claim form
 *    through the UI.
 *
 * Rate-limit budget: the SEP-10 buckets allow 12 requests/min per client and
 * every spec in this suite shares one client (localhost). Each sign-in costs
 * one challenge + one verify. Keep the total number of sign-ins across e2e
 * specs comfortably under that — add specs that reuse a session rather than
 * minting a new one per assertion.
 */

/** Sign a SEP-10 challenge transaction envelope with `kp` (in Node, real crypto). */
export function signChallenge(
  challengeXdr: string,
  networkPassphrase: string,
  kp: Keypair,
): string {
  const tx = TransactionBuilder.fromXDR(challengeXdr, networkPassphrase);
  tx.sign(kp);
  return tx.toXDR();
}

/** SEP-10 sign-in through the API; the session cookie lands in the page's context. */
export async function apiSignIn(page: Page, kp: Keypair = Keypair.random()): Promise<string> {
  const address = kp.publicKey();
  const chal = await page.request.get(`/api/auth/sep10?account=${address}`);
  expect(chal.ok()).toBeTruthy();
  const { transaction, network_passphrase } = (await chal.json()) as {
    transaction: string;
    network_passphrase: string;
  };
  const verify = await page.request.post('/api/auth/sep10', {
    data: { transaction: signChallenge(transaction, network_passphrase, kp) },
  });
  expect(verify.ok()).toBeTruthy();
  return address;
}

/**
 * Install a fake Rabet extension backed by `kp` before the page loads. The
 * page believes a wallet is connected (the app persists its wallet choice in
 * localStorage under `signet:wallet-id`); signing requests round-trip through
 * Node so the signatures are real. Call before `page.goto`.
 */
export async function stubWallet(page: Page, kp: Keypair): Promise<void> {
  // Names the SEP-10 network for the signer; the test server runs testnet.
  const passphrase = 'Test SDF Network ; September 2015';
  await page.exposeFunction('__e2eSignXdr', (xdr: string) => signChallenge(xdr, passphrase, kp));
  await page.addInitScript((publicKey: string) => {
    try {
      window.localStorage.setItem('signet:wallet-id', 'rabet');
    } catch {
      /* opaque-origin frames have no storage; the app's origin does */
    }
    (window as unknown as Record<string, unknown>).rabet = {
      connect: async () => ({ publicKey }),
      sign: async (xdr: string) => ({
        xdr: await (
          window as unknown as { __e2eSignXdr: (x: string) => Promise<string> }
        ).__e2eSignXdr(xdr),
      }),
    };
  }, kp.publicKey());
}
