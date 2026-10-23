import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { apiSignIn } from './support';

/**
 * The wallets page: live indexing state, link dates and a copyable link command
 * (#607). Database-backed (`@db`): the wallets are rows, and "the indexer
 * caught up" is `indexRequestedAt` going back to null, which the spec does
 * directly while the page is open.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const LINK_COMMAND = 'npx @signet/cli link';

test.describe('the wallets page @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: wallets live in the database');

  /** A signed-in owner with an on-chain primary wallet and one terminal-linked wallet still being indexed. */
  async function seedOwnerWithPendingCliWallet(page: import('@playwright/test').Page) {
    const { prisma } = await import('@signet/db');
    const owner = Keypair.random();
    const deploy = Keypair.random();
    await prisma.profile.create({
      data: {
        handle: `wal${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 32),
        wallets: {
          create: [
            { pubkey: owner.publicKey(), source: 'onchain', isPrimary: true },
            {
              pubkey: deploy.publicKey(),
              source: 'cli',
              isPrimary: false,
              attestedAt: new Date('2026-10-12T09:00:00Z'),
              indexRequestedAt: new Date(),
            },
          ],
        },
      },
    });
    await apiSignIn(page, owner);
    return { prisma, deploy };
  }

  test('the indexing badge clears on its own, without a reload', async ({ page }) => {
    // Fake timers, so the 10 s refresh is stepped through instead of waited for.
    await page.clock.install();
    const { prisma, deploy } = await seedOwnerWithPendingCliWallet(page);

    await page.goto('/app/wallets');
    const badge = page.getByText('◌ indexing…');
    await expect(badge).toBeVisible();

    // A marker on the window: a full reload would wipe it, a client-side refresh keeps it.
    await page.evaluate(() => {
      (window as unknown as { __walletsMarker: boolean }).__walletsMarker = true;
    });

    // The indexer scans the wallet; nothing touches the page.
    await prisma.wallet.update({ where: { pubkey: deploy.publicKey() }, data: { indexRequestedAt: null } });
    await page.clock.runFor(10_000);

    await expect(badge).toBeHidden();
    expect(
      await page.evaluate(() => (window as unknown as { __walletsMarker?: boolean }).__walletsMarker),
    ).toBe(true);

    await prisma.$disconnect();
  });

  test('a terminal-linked wallet shows its link date, the primary wallet does not', async ({ page }) => {
    const { prisma } = await seedOwnerWithPendingCliWallet(page);

    await page.goto('/app/wallets');
    await expect(page.getByText('Linked 2026-10-12')).toBeVisible();
    await expect(page.getByText(/^Linked /)).toHaveCount(1);

    await prisma.$disconnect();
  });

  test('the link command can be copied with one click, and the copy is announced', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { prisma } = await seedOwnerWithPendingCliWallet(page);

    await page.goto('/app/wallets');
    const copy = page.getByRole('button', { name: 'Copy command' });
    await expect(copy).toBeVisible();
    await copy.click();

    // The live region is in the page already, so its text change is announced.
    await expect(page.locator('[role="status"][aria-live="polite"]', { hasText: 'Command copied to clipboard' })).toHaveCount(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LINK_COMMAND);

    // And the docs link is there.
    await expect(page.getByRole('link', { name: /CLI docs/ })).toHaveAttribute('href', /docs\/CLI\.md$/);

    await prisma.$disconnect();
  });
});
