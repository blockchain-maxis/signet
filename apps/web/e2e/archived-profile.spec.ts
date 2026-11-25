import { test, expect } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './a11y';
import { ARCHIVED_HANDLE } from './fixtures/docs-failures';

/**
 * Archived profile e2e (#896).
 *
 * Tagged `@db` so it runs in `e2e-linked`, where the shell's attribution has a
 * fixture database. The loader is mocked at the RPC: `globalSetup` stands up a
 * Soroban RPC that answers `simulateTransaction` for the Identity Registry's
 * `resolve` method with a restore preamble, which makes
 * `rpc.Api.isSimulationRestore(sim)` return true.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

test.describe('archived profile @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: attribution reads the fixture database');

  test('shows "Archived" badge and hides wallet, contracts, and activity', async ({ page }) => {
    const res = await page.goto(`/p/${ARCHIVED_HANDLE}`);
    expect(res?.status()).toBe(200);

    // The shell is still there: the h1 names the handle
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    await expect(h1.getByRole('link', { name: `@${ARCHIVED_HANDLE}`, exact: true })).toBeVisible();

    // Shows "Archived on-chain" badge (amber), not "Bound on-chain" (green)
    await expect(page.getByText('Archived on-chain')).toBeVisible();
    await expect(page.getByText('Bound on-chain')).not.toBeVisible();

    // No "Linked wallet" section
    await expect(page.getByRole('heading', { name: 'Linked wallet' })).not.toBeVisible();

    // No "Deployed contracts" section
    await expect(page.getByRole('heading', { name: 'Deployed contracts' })).not.toBeVisible();

    // No "On-chain activity" stats section
    await expect(page.getByRole('heading', { name: 'On-chain activity' })).not.toBeVisible();

    // No "Soroban invocations" section
    await expect(page.getByRole('heading', { name: 'Soroban invocations' })).not.toBeVisible();

    // Verification footer says "archived on-chain"
    await expect(page.getByText(/archived on-chain/i)).toBeVisible();

    await expectNoSeriousA11yViolations(page, 'archived profile');
  });
});