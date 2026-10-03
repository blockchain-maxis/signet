import { test, expect } from '@playwright/test';
import {
  CONTRACT_A,
  CONTRACT_B,
  CONTRACT_C,
  FIXTURE_HANDLE,
  MALFORMED_ADDRESS,
  OTHER_HANDLE,
} from './fixtures/contracts';

/**
 * The contract page, end to end, against real rows (#463).
 *
 * The default e2e run is hermetic (no database), so every contract page 404s
 * there and the happy path cannot be tested. This spec is tagged `@db`: the
 * `e2e-linked` CI job runs it (`--grep @db`) against Postgres, the `e2e` job
 * skips it (`--grep-invert @db`), so each spec runs in exactly one lane.
 *
 * The fixture (`e2e/fixtures/contracts.ts`) is loaded by Playwright's
 * `globalSetup` when `DATABASE_URL` is set. Locally:
 *
 *   pnpm db:up && pnpm db:migrate
 *   DATABASE_URL=… pnpm --filter @signet/web test:e2e
 *
 * Without a database the whole file is skipped, not failed, like
 * `claim-link-profile.spec.ts`.
 *
 * Cases that depend on issues that have not landed are `test.fixme` with the
 * issue named, so the intent is on record and they turn on by removing the
 * marker.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

const TABS = ['', '/functions', '/types', '/diagram', '/run', '/activity'] as const;
const base = (handle: string, address: string) => `/p/${handle}/contract/${address}`;

test.describe('contract page @db', () => {
  test.skip(
    !HAS_DB,
    'needs DATABASE_URL: without a database every contract page 404s, so there is no happy path to test',
  );

  test('an attributed contract returns 200 on all six tabs', async ({ request }) => {
    for (const tab of TABS) {
      const res = await request.get(`${base(FIXTURE_HANDLE, CONTRACT_A)}${tab}`);
      expect(res.status(), `tab "${tab || 'overview'}"`).toBe(200);
    }
  });

  test('the second wallet of the same profile is attributed too', async ({ request }) => {
    const res = await request.get(base(FIXTURE_HANDLE, CONTRACT_B));
    expect(res.status()).toBe(200);
  });

  test('the identity strip shows the handle and the full address', async ({ page }) => {
    await page.goto(base(FIXTURE_HANDLE, CONTRACT_A));
    await expect(page.getByRole('link', { name: `@${FIXTURE_HANDLE}`, exact: true })).toHaveAttribute(
      'href',
      `/p/${FIXTURE_HANDLE}`,
    );
    await expect(page.locator(`[title="${CONTRACT_A}"]`)).toBeVisible();
  });

  test.fixme(
    'the header shows the address, a deploy transaction link and the network (#448)',
    async () => {
      // Turn on with the header (#448): assert the address, a link to the deploy
      // transaction (fixture hash `DEPLOY_TX_A`) and the configured network.
    },
  );

  test('the Run locally command contains the contract address', async ({ page }) => {
    await page.goto(`${base(FIXTURE_HANDLE, CONTRACT_A)}/run`);
    await expect(page.locator('code', { hasText: `signet dev ${CONTRACT_A}` }).first()).toBeVisible();
  });

  test('a contract owned by a different profile is a 404 on all six tabs', async ({ request }) => {
    for (const tab of TABS) {
      const res = await request.get(`${base(OTHER_HANDLE, CONTRACT_A)}${tab}`);
      expect(res.status(), `tab "${tab || 'overview'}"`).toBe(404);
    }
  });

  test('a matching owner on the wrong network is a 404 on all six tabs', async ({ request }) => {
    // CONTRACT_C is deployed by this profile's wallet, but on the network the
    // server is not configured for.
    for (const tab of TABS) {
      const res = await request.get(`${base(FIXTURE_HANDLE, CONTRACT_C)}${tab}`);
      expect(res.status(), `tab "${tab || 'overview'}"`).toBe(404);
    }
  });

  test('a malformed address is a 404', async ({ request }) => {
    for (const address of [MALFORMED_ADDRESS, CONTRACT_A.slice(0, -1) + (CONTRACT_A.endsWith('A') ? 'B' : 'A')]) {
      const res = await request.get(base(FIXTURE_HANDLE, address));
      expect(res.status(), address).toBe(404);
    }
  });

  test.fixme('the legacy /profile/… route redirects to the new route (#447)', async () => {
    // Turn on with #447: GET /profile/{handle}/contract/{address} redirects to
    // /p/{handle}/contract/{address}. Today `profile` is passed through by the
    // middleware and no such route exists.
  });

  test('the profile page lists both attributed contracts, linked, and not the other-network one', async ({
    page,
  }) => {
    await page.goto(`/p/${FIXTURE_HANDLE}`);
    await expect(page.locator(`a[href="${base(FIXTURE_HANDLE, CONTRACT_A)}"]`)).toBeVisible();
    await expect(page.locator(`a[href="${base(FIXTURE_HANDLE, CONTRACT_B)}"]`)).toBeVisible();
    await expect(page.locator(`a[href="${base(FIXTURE_HANDLE, CONTRACT_C)}"]`)).toHaveCount(0);
    await expect(page.getByText('· 2 indexed')).toBeVisible();

    // The link resolves to the contract page.
    await page.locator(`a[href="${base(FIXTURE_HANDLE, CONTRACT_A)}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${base(FIXTURE_HANDLE, CONTRACT_A)}$`));
  });

  test.fixme('the Activity list pages through the API route (#453)', async () => {
    // Turn on with the Activity tab (#453): page through the contract's
    // invocations (fixture: 4 rows) with offset/limit and assert hasMore flips.
  });

  test.fixme('the contract page serves an OG image (#458)', async () => {
    // Turn on with #458: GET {contract page}/opengraph-image returns image/png.
  });
});
