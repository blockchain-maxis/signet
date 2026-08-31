import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { apiSignIn } from './support';

// The dashboard behind the sign-in wall. One session per test (a fresh random
// key is a fresh account), signed in through the API so these tests exercise
// what the session UNLOCKS, not the sign-in mechanics (auth.spec.ts owns those).

test('a signed-in wallet sees its overview, not the wall', async ({ page }) => {
  const kp = Keypair.random();
  await apiSignIn(page, kp);
  await page.goto('/app');

  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Signed-in wallet')).toBeVisible();
  // The identity card shows OUR address (truncated as `GXXXX…XXXX`).
  const truncated = `${kp.publicKey().slice(0, 7)}…${kp.publicKey().slice(-5)}`;
  await expect(page.getByText(truncated)).toBeVisible();

  // A brand-new key has no on-chain binding, and the dashboard must say so
  // honestly — with the claim path as the way forward.
  await expect(page.getByText('No handle is bound to this wallet yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: /claim your handle/i })).toHaveAttribute(
    'href',
    '/#claim',
  );
});

test('dashboard navigation appears only with a session', async ({ page }) => {
  // Signed out: the shell renders, but no section links and no address chip.
  await page.goto('/app');
  await expect(page.getByText('Not signed in')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Wallets' })).toHaveCount(0);

  // Signed in: all four sections and the wallet chip.
  await apiSignIn(page);
  await page.goto('/app');
  for (const label of ['Overview', 'Profile', 'Wallets', 'Settings']) {
    await expect(page.getByRole('link', { name: label })).toBeVisible();
  }
  await expect(page.getByText('Not signed in')).toHaveCount(0);
});
