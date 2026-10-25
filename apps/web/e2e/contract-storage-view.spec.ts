import { test, expect } from '@playwright/test';
import { CONTRACT_A, CONTRACT_B, FIXTURE_HANDLE } from './fixtures/contracts';

/**
 * The storage view (#515) on the Diagram tab. Contract A's fixture
 * invocations claim and resolve an `Owner(String)` key, so it has a slot;
 * contract B has no invocations, so its toggle is disabled with the reason.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const diagram = (address: string, query = '') =>
  `/p/${FIXTURE_HANDLE}/contract/${address}/diagram${query}`;

test.describe('storage layout view (#515) @db', () => {
  test.skip(!HAS_DB, 'needs the contract-page fixture (DATABASE_URL)');

  test('toggling the view on and off keeps focus on the toggle', async ({ page }) => {
    await page.goto(diagram(CONTRACT_A));
    const toggle = page.getByTestId('storage-toggle');
    const view = page.locator('#storage-view');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(view).toBeVisible();
    await expect(view.locator('[data-node-id="slot:persistent:Owner(String)"]')).toHaveCount(1);
    await expect(view).toContainText("Soroban contracts don't declare a storage schema");

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(view).toBeHidden();
    await expect(toggle).toBeFocused();
    expect(new URL(page.url()).searchParams.get('storage')).toBe('0');

    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(view).toBeVisible();
    await expect(toggle).toBeFocused();
    expect(new URL(page.url()).searchParams.get('storage')).toBe('1');
  });

  test('a slot permalink opens the view with the slot focused', async ({ page }) => {
    await page.goto(diagram(CONTRACT_A, `?storage=0&focus=${encodeURIComponent('slot:persistent:Owner(String)')}`));
    const slot = page.locator('#storage-view [data-node-id="slot:persistent:Owner(String)"]');
    await expect(slot).toBeVisible();
    await expect(slot).toHaveClass(/viz-focused/);
  });

  test('with no observations the toggle is disabled, and says why', async ({ page }) => {
    await page.goto(diagram(CONTRACT_B));
    const toggle = page.getByTestId('storage-toggle');
    // B's interface is resolved over the (mock) RPC; without one there is no Diagram tab body.
    test.skip((await toggle.count()) === 0, "contract B's interface did not resolve in this environment");
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).toHaveAccessibleDescription(/No calls to this contract have been observed/);
    await expect(page.locator('#storage-view')).toHaveCount(0);
  });
});
