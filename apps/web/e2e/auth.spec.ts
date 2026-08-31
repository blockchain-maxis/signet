import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { apiSignIn, signChallenge, stubWallet } from './support';

// Sign-in with Stellar (SEP-10): challenge → signature → session. The gate
// either locks everyone out or lets everyone in when it regresses, and a
// page-load smoke test sees neither — so both directions are pinned here:
// the real UI flow succeeds with a valid signature, and the API refuses the
// three ways a signature can be wrong (absent, wrong key, bad account).

test('signing the SEP-10 challenge with the wallet unlocks the dashboard', async ({ page }) => {
  // The full client path, extension aside: the sign-in wall's own button
  // fetches the challenge, "the wallet" (a stub with real ed25519 under it)
  // signs, the verify call sets the session cookie, and the reload renders
  // the dashboard instead of the wall.
  const kp = Keypair.random();
  await stubWallet(page, kp);

  await page.goto('/app');
  await page.getByRole('button', { name: /sign in with wallet/i }).click();

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // The nav chip renders the signed-in wallet, so the session belongs to OUR
  // key — not just any session.
  await expect(page.getByText(`● ${kp.publicKey().slice(0, 5)}`, { exact: false })).toBeVisible();
});

test('challenge endpoint rejects a malformed account', async ({ request }) => {
  const res = await request.get('/api/auth/sep10?account=not-a-stellar-key');
  expect(res.status()).toBe(400);
});

test('a challenge without the client signature earns no session', async ({ page }) => {
  const kp = Keypair.random();
  const chal = await page.request.get(`/api/auth/sep10?account=${kp.publicKey()}`);
  expect(chal.ok()).toBeTruthy();
  const { transaction } = (await chal.json()) as { transaction: string };

  // Posting the challenge straight back (server-signed only) must fail…
  const verify = await page.request.post('/api/auth/sep10', { data: { transaction } });
  expect(verify.status()).toBe(401);

  // …and must not have leaked a cookie: the dashboard still shows the wall.
  await page.goto('/app');
  await expect(page.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
});

test('a challenge signed by a different key than the account is rejected', async ({ request }) => {
  const account = Keypair.random();
  const imposter = Keypair.random();

  const chal = await request.get(`/api/auth/sep10?account=${account.publicKey()}`);
  expect(chal.ok()).toBeTruthy();
  const { transaction, network_passphrase } = (await chal.json()) as {
    transaction: string;
    network_passphrase: string;
  };

  const verify = await request.post('/api/auth/sep10', {
    data: { transaction: signChallenge(transaction, network_passphrase, imposter) },
  });
  expect(verify.status()).toBe(401);
});

test('logout ends the session', async ({ page }) => {
  await apiSignIn(page);
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();

  // The logout route enforces same-origin and refuses requests with no Origin
  // at all, so say who we are — the browser would.
  const res = await page.request.post('/api/auth/logout', {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(res.ok()).toBeTruthy();

  await page.goto('/app');
  await expect(page.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
});
