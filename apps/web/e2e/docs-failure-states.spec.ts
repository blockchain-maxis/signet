import { test, expect, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './a11y';
import { DOCS_HANDLE, NO_INTERFACE, RPC_DOWN, SAC } from './fixtures/docs-failures';

/**
 * Failure and edge states of the docs tabs, end to end (#470).
 *
 * Tagged `@db` so it runs in `e2e-linked`, where the shell's attribution has a
 * fixture database. The loader is mocked at the RPC: `globalSetup` stands up a
 * Soroban RPC that answers per contract (a WASM with no interface section, a
 * Stellar Asset Contract, an RPC that is down), and the e2e server reads it.
 * See `fixtures/docs-failures.ts`.
 *
 * Every state must keep the page a 200 with the shell intact: the handle
 * heading, the address and the header. Only the docs region changes.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);
const TABS = ['functions', 'types'] as const;
const url = (address: string, tab: string) => `/p/${DOCS_HANDLE}/contract/${address}/${tab}`;

/** The shell is still there: the h1 names the handle and the header shows the address. */
async function expectShell(page: Page, address: string) {
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toBeVisible();
  await expect(h1.getByRole('link', { name: `@${DOCS_HANDLE}`, exact: true })).toBeVisible();
  await expect(page.getByTestId('contract-header')).toContainText(address);
}

async function expectNoRawError(page: Page) {
  const text = (await page.locator('main').innerText()).toLowerCase();
  for (const leak of ['stack', 'econnrefused', 'axios', 'status code', 'node_modules', 'at async']) {
    expect(text, `no "${leak}" in the page`).not.toContain(leak);
  }
}

test.describe('docs failure states @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: attribution reads the fixture database');

  for (const tab of TABS) {
    test(`no_interface: a statement about the contract on the ${tab} tab`, async ({ page }) => {
      const res = await page.goto(url(NO_INTERFACE, tab));
      expect(res?.status()).toBe(200);
      await expectShell(page, NO_INTERFACE);

      const state = page.getByTestId('docs-state');
      await expect(state).toHaveAttribute('data-kind', 'no_interface');
      await expect(state.getByRole('heading', { level: 3 })).toHaveText(
        'This contract publishes no interface',
      );
      await expect(page.getByTestId(`slot-${tab}`).getByRole('heading', { level: 2 })).toBeVisible();
      await expectNoRawError(page);
      await expectNoSeriousA11yViolations(page, `no_interface ${tab}`);
    });

    test(`rpc_unavailable: names the network and is not cached on the ${tab} tab`, async ({
      page,
    }) => {
      const res = await page.goto(url(RPC_DOWN, tab));
      expect(res?.status()).toBe(200);
      await expectShell(page, RPC_DOWN);

      const state = page.getByTestId('docs-state');
      await expect(state).toHaveAttribute('data-kind', 'unavailable');
      await expect(state.getByRole('heading', { level: 3 })).toHaveText(
        "Couldn't reach testnet RPC. Try again shortly.",
      );

      // The route is `force-dynamic`: a failed read must never be served from a
      // shared cache, or "try again shortly" would stay true for an hour.
      const cacheControl = res?.headers()['cache-control'] ?? '';
      expect(cacheControl).toMatch(/no-store|no-cache|private/);
      expect(cacheControl).not.toMatch(/s-maxage|public/);

      await expectNoRawError(page);
      await expectNoSeriousA11yViolations(page, `rpc_unavailable ${tab}`);
    });
  }

  test('a Stellar Asset Contract says the protocol defines its interface and lists no functions', async ({
    page,
  }) => {
    const res = await page.goto(url(SAC, 'functions'));
    expect(res?.status()).toBe(200);
    await expectShell(page, SAC);

    const state = page.getByTestId('docs-state');
    await expect(state).toHaveAttribute('data-variant', 'stellar_asset_contract');
    await expect(state.getByRole('heading', { level: 3 })).toHaveText(
      'This is a Stellar Asset Contract',
    );
    await expect(state).toContainText(
      'Its interface is defined by the protocol, not by deployed WASM.',
    );
    await expect(state.getByRole('link', { name: /SEP-41/ })).toHaveAttribute(
      'href',
      /sep-0041\.md$/,
    );
    await expect(page.getByTestId('slot-functions').locator('ul, li')).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'stellar asset contract');
  });

  test('the Overview and the docs tab say the same thing for no_interface', async ({ page }) => {
    await page.goto(`/p/${DOCS_HANDLE}/contract/${NO_INTERFACE}`);
    await expect(page.getByText('This contract publishes no interface').first()).toBeVisible();
  });
});
