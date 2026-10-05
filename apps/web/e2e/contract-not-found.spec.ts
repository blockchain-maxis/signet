import { test, expect } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './a11y';

/**
 * The contract route's 404 state (#459), in the hermetic lane.
 *
 * With no database every contract request is "not attributed", which is exactly
 * the state under test, so this needs no fixture and runs everywhere. The
 * attributed cases live in `contract-page.spec.ts` (@db).
 *
 * Two things are asserted on purpose. The status is a real 404 on every tab: a
 * `loading.tsx` flushes the response early, and one placed above the layout
 * would turn this into a soft 404 (200 + noindex), the trap noted in
 * `app/(dashboard)/app/loading.tsx`. And the copy is the contract-specific one,
 * which only appears if Next renders the boundary in `contract/` for a
 * `notFound()` thrown from the `[address]` layout.
 *
 * Not covered here: the error boundary. It needs attribution to be undecidable
 * (database and Horizon both unreachable after a profile resolves), which the
 * hermetic server cannot be put into without a mock Horizon. Its view and its
 * retry button are unit-tested instead (`lib/contract-error.test.ts`): that
 * proves the button calls the `retry` Next hands the boundary, not that a real
 * server-side failure recovers after a retry.
 */

const HANDLE = 'e2e-nobody';
// A real StrKey shape; no deployment of it exists anywhere.
const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const TABS = ['', '/functions', '/types', '/diagram', '/run', '/activity'] as const;

test.describe('contract route 404', () => {
  test('is a real 404 on all six tabs, never a soft 200', async ({ request }) => {
    for (const tab of TABS) {
      const res = await request.get(`/p/${HANDLE}/contract/${ADDRESS}${tab}`);
      expect(res.status(), `tab "${tab || 'overview'}"`).toBe(404);
    }
  });

  test('says the contract is not on this handle’s record, and offers both ways out', async ({ page }) => {
    const res = await page.goto(`/p/${HANDLE}/contract/${ADDRESS}`);
    expect(res?.status()).toBe(404);

    await expect(page.getByRole('heading', { level: 1, name: 'Contract not found' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText(`This contract isn't part of @${HANDLE}'s record.`);

    await expect(page.getByRole('link', { name: `View @${HANDLE}'s profile` })).toHaveAttribute(
      'href',
      `/p/${HANDLE}`,
    );
    const explorer = page.getByRole('link', { name: /Look it up on Stellar Expert/ });
    await expect(explorer).toHaveAttribute(
      'href',
      new RegExp(`^https://stellar\\.expert/explorer/(testnet|public)/contract/${ADDRESS}$`),
    );
    await expect(explorer).toHaveAttribute('target', '_blank');
    await expect(explorer).toHaveAttribute('rel', /noopener/);
  });

  test('a malformed address says so and offers no explorer link', async ({ page }) => {
    const res = await page.goto(`/p/${HANDLE}/contract/not-a-contract-address`);
    expect(res?.status()).toBe(404);

    await expect(page.getByRole('heading', { level: 1, name: 'Contract not found' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText("doesn't look like a contract address");
    await expect(page.getByRole('link', { name: /Stellar Expert/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: `View @${HANDLE}'s profile` })).toBeVisible();
  });

  test('shows no stack trace and is not blank', async ({ page }) => {
    await page.goto(`/p/${HANDLE}/contract/${ADDRESS}`);
    // The boundary renders on the client: wait for it before measuring the page.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const text = (await page.locator('body').innerText()).trim();
    expect(text.length).toBeGreaterThan(40);
    expect(text).not.toMatch(/\bat \S+ \(.+:\d+:\d+\)|Error:|digest/i);
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await page.goto(`/p/${HANDLE}/contract/${ADDRESS}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'contract 404');
  });
});
