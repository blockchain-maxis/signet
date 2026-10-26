import { test, expect } from '@playwright/test';

/**
 * The published API docs (#649): the overview lists the endpoints, an
 * operation page shows a runnable curl, and the page structure holds for a
 * screen reader (hierarchical headings, named copy buttons). No database.
 */

test('the overview links to every operation page', async ({ page }) => {
  await page.goto('/docs/api');
  await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
  const links = page.locator('a[href^="/docs/api/"]');
  expect(await links.count()).toBeGreaterThan(5);
  await expect(page.getByRole('button', { name: 'Copy base URL example' })).toBeVisible();
});

test('an operation page has a curl example against /api/v1/', async ({ page }) => {
  await page.goto('/docs/api');
  await page.locator('a[href="/docs/api/getProfileContract"]').click();
  await expect(page).toHaveURL(/\/docs\/api\/getProfileContract$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Whether a handle deployed a contract',
  );

  const curl = page.getByLabel('curl example', { exact: true });
  await expect(curl).toContainText('/api/v1/');
  await expect(curl).toContainText('/profiles/alice/contracts/C');
  await expect(page.getByRole('button', { name: 'Copy curl example' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy @signet/sdk example' })).toBeVisible();
  await expect(page.getByLabel('@signet/sdk example', { exact: true })).toContainText(
    'signet.getContract(',
  );
});

test('headings never skip a level', async ({ page }) => {
  for (const path of ['/docs/api', '/docs/api/getProfileContracts']) {
    await page.goto(path);
    const levels = await page
      .locator('main h1, main h2, main h3, main h4')
      .evaluateAll((els) => els.map((e) => Number(e.tagName.slice(1))));
    expect(levels[0], path).toBe(1);
    for (let i = 1; i < levels.length; i++) {
      expect(
        levels[i]! - levels[i - 1]!,
        `${path}: h${levels[i - 1]} then h${levels[i]}`,
      ).toBeLessThanOrEqual(1);
    }
  }
});

test('an unknown operation is a 404', async ({ request }) => {
  const res = await request.get('/docs/api/notAnOperation');
  expect(res.status()).toBe(404);
});
