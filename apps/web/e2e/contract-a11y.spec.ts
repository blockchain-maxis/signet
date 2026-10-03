import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { expectNoSeriousA11yViolations } from './a11y';

/**
 * Accessibility of the contract page (#461).
 *
 * Needs a database: without one every contract page 404s (attribution is a
 * database question, with a Horizon fallback that cannot see a random key), so
 * this is tagged `@db` and skipped in the hermetic `e2e` job.
 *
 *   pnpm db:up && pnpm db:migrate
 *   DATABASE_URL=… pnpm --filter @signet/web exec playwright test e2e/contract-a11y.spec.ts
 *
 * The contract is seeded straight into the database — the same shortcut the
 * linked-flow spec takes for the claim — because what is under test is the
 * rendered page, not the indexer.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const TABS = [
  { label: 'Overview', segment: '', h2: 'Overview' },
  { label: 'Functions', segment: '/functions', h2: 'Functions' },
  { label: 'Types', segment: '/types', h2: 'Types' },
  { label: 'Diagram', segment: '/diagram', h2: 'Diagram' },
  { label: 'Run locally', segment: '/run', h2: 'Run locally' },
  { label: 'Activity', segment: '/activity', h2: 'Activity' },
] as const;

test.describe('contract page accessibility @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: contract pages 404 without the fixture database');

  const suffix = Date.now().toString(36);
  const handle = `a11y${suffix}`.slice(0, 32);
  const address = StrKey.encodeContract(randomBytes(32));
  const base = `/p/${handle}/contract/${address}`;

  test.beforeAll(async () => {
    const { prisma } = await import('@signet/db');
    const deployer = Keypair.random().publicKey();
    const profile = await prisma.profile.create({
      data: {
        handle,
        wallets: { create: { pubkey: deployer, source: 'onchain', isPrimary: true } },
      },
      include: { wallets: true },
    });
    await prisma.contract.create({
      data: {
        address,
        walletId: profile.wallets[0]!.id,
        deployerPubkey: deployer,
        deployedAt: new Date(),
        deployTxHash: randomBytes(32).toString('hex'),
        network: 'testnet',
      },
    });
  });

  test('every tab has one h1, an h2, and no serious axe violations', async ({ page }) => {
    // Six page loads plus six axe runs; the default 30s is tight on a busy CI box.
    test.setTimeout(120_000);
    for (const tab of TABS) {
      await page.goto(`${base}${tab.segment}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(`by @${handle}`);
      await expect(page.getByRole('heading', { level: 2, name: tab.h2 })).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Contract sections' }).getByRole('link', { name: tab.label }),
      ).toHaveAttribute('aria-current', 'page');
      await expectNoSeriousA11yViolations(page, tab.label);
    }
  });

  test('the tab bar is a nav of links, not an ARIA tablist', async ({ page }) => {
    await page.goto(base);
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
  });

  test('keyboard only: skip link, every tab in order, then focus lands on the new h2', async ({
    page,
  }) => {
    await page.goto(base);

    // First stop is the skip link; Enter moves to the content region.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to contract content' });
    await expect(skip).toBeFocused();

    // Tab order: (site nav links, unknown count) … handle link, then each tab.
    const nav = page.getByRole('navigation', { name: 'Contract sections' });
    await page.getByRole('link', { name: `@${handle}` }).focus();
    for (const tab of TABS) {
      await page.keyboard.press('Tab');
      await expect(nav.getByRole('link', { name: tab.label })).toBeFocused();
    }

    // Enter on a tab navigates and moves focus to that tab's h2.
    await nav.getByRole('link', { name: 'Functions' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${base}/functions$`));
    await expect(page.getByRole('heading', { level: 2, name: 'Functions' })).toBeFocused();

    // Skip link jumps into <main>.
    await page.reload();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#contract-content$/);
  });

  test('copy button is named for what it copies and announces via one live region', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`${base}/run`);
    // The handler only exists once the client component has hydrated.
    await page.waitForLoadState('networkidle');
    const copy = page.getByRole('button', { name: 'Copy signet dev command' });
    await copy.focus();
    await page.keyboard.press('Enter');
    // Exactly one polite live region on the contract page carries the message
    // (the "not released" notice is a separate, static status).
    await expect(page.getByRole('status').filter({ hasText: 'Command copied' })).toHaveCount(1);
  });

  test('external links announce that they open a new tab', async ({ page }) => {
    await page.goto(`${base}/run`);
    const links = page.locator('a[target="_blank"]');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(links.nth(i)).toContainText('(opens in a new tab)');
    }
  });
});
