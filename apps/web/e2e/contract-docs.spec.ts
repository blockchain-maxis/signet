import { test, expect, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './a11y';
import { NO_INTERFACE, DOCS_HANDLE } from './fixtures/docs-failures';
import {
  REGISTRY,
  REGISTRY_FUNCTIONS,
  REGISTRY_HANDLE,
  UNDOCUMENTED,
} from './fixtures/docs-registry';

/**
 * Accessibility, responsive layout and coverage of the docs view (#472).
 *
 * Tagged `@db` so it runs in `e2e-linked`, where the fixture database exists;
 * the hermetic `e2e` job has none and every contract page 404s there.
 *
 * The interfaces come from `fixtures/docs-registry.ts`: a hand-written
 * `SpecJson` per WASM hash in the spec store, which the docs tabs read before
 * they ask any RPC. That is the test-only loader override, and it keeps this
 * spec off the network.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

const registryBase = `/p/${REGISTRY_HANDLE}/contract/${REGISTRY}`;
const undocumentedBase = `/p/${REGISTRY_HANDLE}/contract/${UNDOCUMENTED}`;

const TABS = [
  { name: 'Overview', segment: '' },
  { name: 'Functions', segment: '/functions' },
  { name: 'Types', segment: '/types' },
] as const;

/** Anything served from the app itself or from the page's own inline resources. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOCAL_PROTOCOLS = new Set(['data:', 'blob:', 'about:']);

/** Heading levels in document order, for the outline checks. */
async function headingLevels(page: Page): Promise<number[]> {
  return page
    .locator('h1, h2, h3, h4, h5, h6')
    .evaluateAll((els) => els.map((el) => Number(el.tagName.slice(1))));
}

/** A heading level may go down one at a time, and up by any amount; it never skips a level. */
function expectNoSkippedLevels(levels: readonly number[], label: string) {
  expect(levels[0], `${label}: the outline starts at the h1`).toBe(1);
  for (let i = 1; i < levels.length; i++) {
    expect(
      levels[i]! - levels[i - 1]!,
      `${label}: heading ${i} (h${levels[i]}) follows an h${levels[i - 1]}`,
    ).toBeLessThanOrEqual(1);
  }
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (scrollWidth > clientWidth) {
    // Name what sticks out, so a failure says which element to fix.
    const offenders = await page.evaluate((limit) => {
      const describe = (el: Element) => {
        const box = el.getBoundingClientRect();
        const testId = el.getAttribute('data-testid');
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
        return `<${el.tagName.toLowerCase()}${testId ? ` data-testid=${testId}` : ''}> right=${Math.round(box.right)} width=${Math.round(box.width)} "${text}"`;
      };
      return Array.from(document.body.querySelectorAll('*'))
        .filter((el) => el.getBoundingClientRect().right > limit + 1)
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
        .slice(0, 6)
        .map(describe);
    }, clientWidth);
    expect(
      scrollWidth,
      `${label}: page is ${scrollWidth}px wide in a ${clientWidth}px viewport; widest elements:\n  ${offenders.join('\n  ')}`,
    ).toBeLessThanOrEqual(clientWidth);
  }
}

/**
 * Tab to `link` (it must be reachable by keyboard, in order), press Enter, and
 * check that the browser put focus on the section the link names.
 */
async function followByKeyboard(page: Page, url: string, linkIn: (page: Page) => Locator, index: number) {
  await page.goto(url);
  const link = linkIn(page).nth(index);
  const href = (await link.getAttribute('href')) ?? '';
  const fragment = href.split('#')[1] ?? '';
  expect(fragment, `link ${index} names a fragment`).not.toBe('');

  // Reach it the way a keyboard user does: from the previous link, by Tab.
  if (index === 0) {
    await link.focus();
  } else {
    await linkIn(page).nth(index - 1).focus();
    for (let presses = 0; presses < 8 && !(await link.evaluate((el) => el === document.activeElement)); presses++) {
      await page.keyboard.press('Tab');
    }
  }
  await expect(link, `link ${index} is reachable by Tab`).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#${fragment}$`));
  await expect(page.locator(`[id="${fragment}"]`)).toBeFocused();
}

test.describe('contract docs accessibility and layout @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: contract pages 404 without the fixture database');

  // Every test below also proves the run stays on this machine.
  let external: string[] = [];
  test.beforeEach(({ page }) => {
    external = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (LOCAL_PROTOCOLS.has(url.protocol)) return;
      if (!LOCAL_HOSTS.has(url.hostname)) external.push(request.url());
    });
  });
  test.afterEach(() => {
    expect(external, 'requests to a host other than localhost').toEqual([]);
  });

  test('the Functions tab lists the 8 registry functions, each with its anchor', async ({ page }) => {
    await page.goto(`${registryBase}/functions`);
    const sections = page.getByTestId('function-section');
    await expect(sections).toHaveCount(8);
    await expect(sections).toHaveCount(REGISTRY_FUNCTIONS.length);
    for (const [i, name] of REGISTRY_FUNCTIONS.entries()) {
      const section = sections.nth(i);
      await expect(section).toHaveAttribute('id', `fn-${name}`);
      await expect(section.getByRole('heading', { level: 3, name })).toBeVisible();
      // The signature is code, not prose.
      await expect(section.getByTestId('function-signature').locator('code')).toHaveCount(1);
    }
  });

  test('…/functions#fn-claim scrolls to its section and moves focus there', async ({ page }) => {
    await page.goto(`${registryBase}/functions#fn-claim`);
    const claim = page.locator('#fn-claim');
    await expect(claim).toBeInViewport();
    await expect(claim).toBeFocused();

    // A section far down the page: the page scrolls to it.
    await page.goto(`${registryBase}/functions#fn-set_metadata`);
    await expect(page.locator('#fn-set_metadata')).toBeInViewport();
    await expect(page.locator('#fn-set_metadata')).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('headings run h1, then h2 per section, then h3 per item, on every tab', async ({ page }) => {
    for (const tab of TABS) {
      await page.goto(`${registryBase}${tab.segment}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 2, name: tab.name })).toBeVisible();
      expectNoSkippedLevels(await headingLevels(page), tab.name);
    }

    await page.goto(`${registryBase}/functions`);
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(8);

    // Errors is a section of its own, a sibling of Types, not an item of it.
    await page.goto(`${registryBase}/types`);
    await expect(page.getByRole('heading', { level: 2, name: 'Errors' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'Binding' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: 'RegistryError' })).toBeVisible();
  });

  test('tables have column and row headers, and buttons have names', async ({ page }) => {
    for (const tab of TABS) {
      await page.goto(`${registryBase}${tab.segment}`);
      const cells = await page.locator('main table th').evaluateAll((els) =>
        els.map((el) => el.getAttribute('scope')),
      );
      for (const scope of cells) expect(['col', 'row']).toContain(scope);

      const names = await page.locator('main button').evaluateAll((els) =>
        els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
      );
      for (const name of names) expect(name).not.toBe('');
    }
    // The tables the check is about exist: arguments on Functions, errors on Types.
    await page.goto(`${registryBase}/functions`);
    await expect(page.getByRole('table', { name: 'Arguments of claim' })).toBeVisible();
    await page.goto(`${registryBase}/types`);
    await expect(page.getByRole('table', { name: 'Error codes of RegistryError' })).toBeVisible();
  });

  test('type links are underlined, so colour is not the only cue', async ({ page }) => {
    await page.goto(`${registryBase}/functions`);
    const links = page.getByTestId('slot-functions').locator('a[href*="#type-"]:visible');
    expect(await links.count()).toBeGreaterThan(0);
    const decorations = await links.evaluateAll((els) =>
      els.map((el) => getComputedStyle(el).textDecorationLine),
    );
    for (const line of decorations) expect(line).toContain('underline');
  });

  test('Overview, Functions, Types and Errors have no serious axe violations', async ({ page }) => {
    // Three tabs, two fixtures, one axe run each.
    test.setTimeout(120_000);
    for (const tab of TABS) {
      await page.goto(`${registryBase}${tab.segment}`);
      await expectNoSeriousA11yViolations(page, `registry ${tab.name}`);
    }
    // The Errors section sits on the Types tab; check it with its details open too.
    await page.goto(`${registryBase}/types`);
    await expect(page.getByTestId('error-list')).toBeVisible();
    await page.getByTestId('unused-types').locator('summary').click();
    await expectNoSeriousA11yViolations(page, 'registry Types with unused types open');

    for (const tab of TABS) {
      await page.goto(`${undocumentedBase}${tab.segment}`);
      await expectNoSeriousA11yViolations(page, `undocumented ${tab.name}`);
    }
  });

  test('every type link on the Functions tab is reachable by Tab and lands on its target', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const linksIn = (p: Page) => p.getByTestId('slot-functions').locator('a[href*="#type-"]:visible');
    await page.goto(`${registryBase}/functions`);
    const count = await linksIn(page).count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await followByKeyboard(page, `${registryBase}/functions`, linksIn, i);
    }
  });

  test('every type link on the Types tab is reachable by Tab and lands on its target', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const linksIn = (p: Page) => p.getByTestId('slot-types').locator('a[href*="#type-"]:visible');
    await page.goto(`${registryBase}/types`);
    const count = await linksIn(page).count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await followByKeyboard(page, `${registryBase}/types`, linksIn, i);
    }
  });

  test('at 360px no tab scrolls sideways, long signatures included', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 360, height: 740 });
    for (const base of [registryBase, undocumentedBase]) {
      for (const tab of TABS) {
        await page.goto(`${base}${tab.segment}`);
        await expectNoHorizontalOverflow(page, `${base}${tab.segment}`);
      }
    }

    // The long signature wraps: it takes several lines, and each argument sits whole on a line.
    await page.goto(`${undocumentedBase}/functions`);
    const signature = page
      .locator('#fn-record_observation_with_a_deliberately_long_function_name')
      .getByTestId('function-signature');
    const box = await signature.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(360);
    expect(box!.height).toBeGreaterThan(60);
  });

  test('a contract with no doc comments shows one page-level note and no per-function placeholder', async ({
    page,
  }) => {
    await page.goto(`${undocumentedBase}/functions`);
    await expect(page.getByTestId('no-doc-comments-note')).toHaveCount(1);
    const sections = page.getByTestId('function-section');
    await expect(sections).toHaveCount(2);
    // Each section is its name and its signature; nothing stands in for a doc comment.
    for (let i = 0; i < 2; i++) {
      await expect(sections.nth(i).locator('p')).toHaveCount(1);
    }

    // A documented contract has no such note.
    await page.goto(`${registryBase}/functions`);
    await expect(page.getByTestId('no-doc-comments-note')).toHaveCount(0);
  });

  test('a contract that publishes no interface says so on the docs tabs', async ({ page }) => {
    for (const tab of ['functions', 'types']) {
      await page.goto(`/p/${DOCS_HANDLE}/contract/${NO_INTERFACE}/${tab}`);
      await expect(page.getByText('This contract publishes no interface')).toBeVisible();
    }
  });

  test('the whole run makes no request to a host other than localhost', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (request) => seen.push(request.url()));
    for (const tab of TABS) {
      await page.goto(`${registryBase}${tab.segment}`);
      await page.waitForLoadState('networkidle');
    }
    expect(seen.length).toBeGreaterThan(0);
    const hosts = new Set(
      seen
        .map((u) => new URL(u))
        .filter((u) => !LOCAL_PROTOCOLS.has(u.protocol))
        .map((u) => u.hostname),
    );
    for (const host of hosts) expect(LOCAL_HOSTS.has(host), `request to ${host}`).toBe(true);
    // The describe-level collector agrees.
    expect(external).toEqual([]);
  });
});
