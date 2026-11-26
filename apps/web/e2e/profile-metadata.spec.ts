import { test, expect } from '@playwright/test';
import { CONTRACT_A, FIXTURE_HANDLE } from './fixtures/contracts';

/**
 * Canonical and social metadata on a real profile, and the lowercase redirect
 * for a mixed-case handle in a contract URL (#900).
 *
 * Tagged `@db` so it runs in `e2e-linked`: the hermetic smoke run has no
 * profiles, so only the fixture database can serve a profile page here.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

test.describe('profile metadata @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: the profile comes from the fixture database');

  test('a profile page names its handle in og:title and declares its canonical URL', async ({
    page,
  }) => {
    const res = await page.goto(`/p/${FIXTURE_HANDLE}`);
    expect(res?.status()).toBe(200);

    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute('content');
    expect(ogTitle).toContain(FIXTURE_HANDLE);

    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    expect(canonical).toBeTruthy();
    expect(new URL(canonical!, page.url()).pathname).toBe(`/p/${FIXTURE_HANDLE}`);
  });

  test('a mixed-case handle in a contract URL redirects permanently to the lowercase one', async ({
    request,
  }) => {
    const mixed = `/p/${FIXTURE_HANDLE.toUpperCase()}/contract/${CONTRACT_A}`;
    const res = await request.get(mixed, { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    const location = new URL(res.headers()['location']!, 'http://localhost');
    expect(location.pathname).toBe(`/p/${FIXTURE_HANDLE}/contract/${CONTRACT_A}`);
  });
});
