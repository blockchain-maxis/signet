import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { expectNoSeriousA11yViolations } from './a11y';
import { apiSignIn } from './support';
import { CONTRACT_A, FIXTURE_HANDLE } from './fixtures/contracts';

/**
 * Automated accessibility checks (#659).
 *
 * The first block is hermetic and runs in the `e2e` job: the public pages,
 * which need no database. The `@db` block runs in `e2e-linked` and covers the
 * pages that only render against the fixture database — the profile, every
 * contract tab, and the `/link` approval page.
 *
 *   pnpm db:up && pnpm db:migrate
 *   DATABASE_URL=… pnpm --filter @signet/web test:e2e
 *
 * Findings we are not fixing in this pass are accepted by rule id in
 * `KNOWN_VIOLATIONS` (see `./a11y`), each naming the issue that removes it.
 * That list may shrink but must not grow without review.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);

const PUBLIC_ROUTES = [
  { label: 'landing', path: '/' },
  { label: 'handles', path: '/handles' },
  { label: 'how it works', path: '/how-it-works' },
  { label: 'docs', path: '/docs' },
  { label: 'dashboard (signed out)', path: '/app' },
] as const;

test.describe('public route accessibility', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.label} has no serious axe violations`, async ({ page }) => {
      await page.goto(route.path);
      await expectNoSeriousA11yViolations(page, route.label);
    });
  }
});

const CONTRACT_TABS = [
  { label: 'Overview', segment: '' },
  { label: 'Functions', segment: '/functions' },
  { label: 'Types', segment: '/types' },
  { label: 'Diagram', segment: '/diagram' },
  { label: 'Run locally', segment: '/run' },
  { label: 'Activity', segment: '/activity' },
] as const;

test.describe('database-backed route accessibility @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: these pages only exist with the fixture database');

  test('the profile page has no serious axe violations', async ({ page }) => {
    await page.goto(`/p/${FIXTURE_HANDLE}`);
    await expectNoSeriousA11yViolations(page, `profile ${FIXTURE_HANDLE}`);
  });

  test('every contract tab has no serious axe violations', async ({ page }) => {
    // Six page loads plus six axe runs; the default 30s is tight on a busy CI box.
    test.setTimeout(120_000);
    const base = `/p/${FIXTURE_HANDLE}/contract/${CONTRACT_A}`;
    for (const tab of CONTRACT_TABS) {
      await page.goto(`${base}${tab.segment}`);
      await expectNoSeriousA11yViolations(page, `contract ${tab.label}`);
    }
  });

  test('the link approval page has no serious axe violations', async ({ page }) => {
    // /link only renders its approval form for a signed-in account that owns a
    // handle, so mint one: the fixture wallets are known only by their public
    // key, and a session needs the secret.
    const { prisma } = await import('@signet/db');
    const owner = Keypair.random();
    await prisma.profile.create({
      data: {
        handle: `a11y${Date.now().toString(36)}`.slice(0, 32),
        wallets: { create: { pubkey: owner.publicKey(), source: 'onchain', isPrimary: true } },
      },
    });

    const started = await page.request.post('/api/cli/pair/start', {
      data: { network: 'testnet', publicKey: Keypair.random().publicKey() },
    });
    expect(started.ok(), 'pair/start should mint a pairing').toBeTruthy();
    const { state, userCode } = (await started.json()) as { state: string; userCode: string };

    await apiSignIn(page, owner);
    await page.goto(`/link?code=${state}&user_code=${userCode}`);
    await expect(page.getByRole('button', { name: /approve/i })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'link approval');

    await prisma.$disconnect();
  });
});
