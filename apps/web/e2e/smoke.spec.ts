import { test, expect } from '@playwright/test';

// End-to-end smoke coverage of the real rendered app. Run against a production
// build via `pnpm --filter @signet/web test:e2e` (see playwright.config.ts).

test('landing page renders the hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
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
