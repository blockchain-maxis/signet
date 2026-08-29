import { test, expect } from '@playwright/test';

// End-to-end smoke coverage of the real rendered app. Run against a production
// build via `pnpm --filter @signet/web test:e2e` (see playwright.config.ts).

test('landing page renders the hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('landing page contains #claim anchor for cross-site claim links', async ({ page }) => {
  await page.goto('/');
  const claimSection = page.locator('#claim');
  await expect(claimSection).toBeAttached();
  await expect(claimSection.getByRole('button', { name: /connect wallet|claim your handle/i })).toBeVisible();
});

test('health endpoint reports ok or degraded', async ({ request }) => {
  // The route handler lives at /api/health; a bare /health falls through
  // middleware to the marketing root and returns HTML.
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(['ok', 'degraded']).toContain(body.status);
});

test('demo profile renders with the testnet badge', async ({ page }) => {
  await page.goto('/p/aquawolf');
  await expect(page.getByText(/Synthetic data · Testnet demo/i)).toBeVisible();
  await expect(page.getByText('@aquawolf')).toBeVisible();
});

test('unknown handle 404s', async ({ page }) => {
  const res = await page.goto('/p/this-handle-does-not-exist');
  expect(res?.status()).toBe(404);
});

test('dashboard shows the sign-in wall when unauthenticated', async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
});

test('the handle directory never presents demo personas as on-chain bindings', async ({ page }) => {
  // Regression guard: /handles used to render the curated demo manifest under
  // the caption "N handles currently bound on the Identity Registry", so three
  // unbound personas were asserted as registry state. Demo handles may only
  // appear inside the explicitly-labelled preview section.
  await page.goto('/handles');

  const previews = page.locator('section', { hasText: 'Demo profiles' });
  await expect(previews.getByText(/Not bound on-chain/i)).toBeVisible();
  await expect(previews.getByText('@aquawolf')).toBeVisible();

  // The count in the caption comes from the contract, so with no registry
  // configured it must not claim any binding at all.
  await expect(page.getByText(/handles? currently bound on the Identity Registry/i)).toHaveCount(0);
});

test('closing CTA is a real connect-wallet button, not a dead link', async ({ page }) => {
  await page.goto('/');
  // The closing section, anchored by its headline.
  const close = page.locator('section', { hasText: 'Create your record.' });
  // Regression guard: this CTA used to be a plain <a href="#"> with no handler.
  await expect(close.locator('a[href="#"]')).toHaveCount(0);
  // It now renders the shared ConnectWallet control, wired to connect + claim
  // exactly like the hero CTA (accessible name "Connect wallet" when signed out).
  await expect(close.getByRole('button', { name: /connect wallet/i })).toBeVisible();
});

test('how-it-works page renders', async ({ page }) => {
  await page.goto('/how-it-works');
  await expect(page.getByText(/Phase 2/i).first()).toBeVisible();
});

test('handles directory lists the curated handles and links to profiles', async ({ page }) => {
  await page.goto('/handles');
  await expect(page.getByRole('heading', { name: 'Handles' })).toBeVisible();
  const link = page.getByRole('link', { name: '@aquawolf' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/p/aquawolf');
});
