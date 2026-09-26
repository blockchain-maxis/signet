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
  await expect(
    claimSection.getByRole('button', { name: /connect wallet|claim your handle/i }),
  ).toBeVisible();
});

test('health endpoint reports ok or degraded', async ({ request }) => {
  // The route handler lives at /api/health; a bare /health falls through
  // middleware to the marketing root and returns HTML.
  const res = await request.get('/api/health');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(['ok', 'degraded']).toContain(body.status);
});

test('unknown handle 404s', async ({ page }) => {
  const res = await page.goto('/p/this-handle-does-not-exist');
  expect(res?.status()).toBe(404);
});

test('dashboard shows the sign-in wall when unauthenticated', async ({ page }) => {
  await page.goto('/app');
  await expect(page.getByRole('button', { name: /sign in with wallet/i })).toBeVisible();
});

test('the handle directory says so, and lists nothing, when no registry is configured', async ({ page }) => {
  // The e2e server runs without a registry contract id. There is no fallback
  // list of handles: the page must say why it is empty rather than invent any.
  await page.goto('/handles');
  await expect(page.getByRole('heading', { name: 'Handles' })).toBeVisible();
  await expect(page.getByText(/No Identity Registry is configured/i)).toBeVisible();
  await expect(page.locator('a[href^="/p/"]')).toHaveCount(0);

  // The count in the caption comes from the contract, so with no registry
  // configured it must not claim any recorded binding at all (the caption
  // says "recorded by", deliberately not "currently bound on" — the counter
  // is an upper bound that cannot self-correct after storage archival).
  await expect(page.getByText(/handles? recorded by the Identity Registry/i)).toHaveCount(0);
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
  await expect(page.getByRole('heading', { level: 1, name: /How Signet works/i })).toBeVisible();
});

test('landing page links to the real directory, not a demo profile', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a[href^="/p/"]')).toHaveCount(0);
  await expect(page.locator('a[href="/handles"]').first()).toBeAttached();
});
