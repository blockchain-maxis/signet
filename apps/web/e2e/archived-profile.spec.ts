import { test, expect } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './a11y';
import { ARCHIVED_HANDLE } from './fixtures/docs-failures';

/**
 * Archived profile e2e (#896).
 *
 * Tagged `@db` so it runs in `e2e-linked`, the job where `globalSetup` stands
 * up the mock Soroban RPC (`fixtures/docs-failures.ts`). The handle is not in
 * the database, so the page falls through to the chain layer, and the mock
 * answers the Identity Registry's `resolve` for it with a restore preamble:
 * the ledger entry is archived.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

test.describe('archived profile @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: the mock RPC only runs with the fixture database');

  test('says the binding is archived and hides the wallet, contracts and activity', async ({
    page,
  }) => {
    const res = await page.goto(`/p/${ARCHIVED_HANDLE}`);
    expect(res?.status()).toBe(200);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ARCHIVED_HANDLE);
    await expect(page.getByText('Archived on-chain · Identity Registry')).toBeVisible();
    await expect(page.getByText(/Bound on-chain/i)).toHaveCount(0);

    // Hidden, not rendered empty.
    await expect(page.getByText('Linked wallet', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Deployed contracts/i)).toHaveCount(0);
    await expect(page.getByText(/On-chain activity/i)).toHaveCount(0);
    await expect(page.getByText(/No contracts are recorded/i)).toHaveCount(0);

    // The verification footer explains the state.
    await expect(page.getByText(/its ledger\s+entry has expired/i)).toBeVisible();

    await expectNoSeriousA11yViolations(page, 'archived profile');
  });
});
