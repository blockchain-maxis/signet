import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TOKEN = 'kq3Zp0X8wQ1m5Ytv7Hc2LnR4sJd9BfE6uA-bC_xYz12';
const open = (page: Page, view?: string) => page.goto(`/#t=${TOKEN}${view ? `&view=${view}` : ''}`);

async function noSeriousViolations(page: Page, what: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) }));
  expect(serious, `${what}: serious or critical axe violations`).toEqual([]);
}

/** Presses Tab until `target` has focus, as a keyboard user would. */
async function tabTo(page: Page, target: Locator, limit = 60) {
  for (let i = 0; i < limit; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${target}`);
}

test('the cycle and its A/B differences have no serious violations', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('listbox', { name: 'Calls in this cycle' })).toBeVisible();
  await noSeriousViolations(page, 'cycle view');
});

test('the call form, and a result, have no serious violations', async ({ page }) => {
  await open(page, 'call');
  const form = page.getByRole('form', { name: /^Call / });
  await expect(form).toBeVisible();
  await noSeriousViolations(page, 'call form');
  await page.getByRole('navigation', { name: 'Functions' }).getByRole('button', { name: 'claim' }).click();
  await page.getByLabel(/^handle/).fill('alice');
  await page.getByLabel(/^wallet/).fill('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7');
  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByRole('article', { name: 'Write preview: claim' })).toBeVisible();
  await noSeriousViolations(page, 'results');
});

test('the state view has no serious violations', async ({ page }) => {
  await open(page, 'state');
  await expect(page.getByRole('table')).toBeVisible();
  await noSeriousViolations(page, 'state view');
});

test('the diagram view has no serious violations', async ({ page }) => {
  await open(page, 'diagram');
  await expect(page.getByRole('region', { name: "This build's diagram" })).toBeVisible();
  await noSeriousViolations(page, 'diagram view');
});

test('with the keyboard alone: run a call, land on its result, then open a diff', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('listbox', { name: 'Calls in this cycle' })).toBeVisible();

  await tabTo(page, page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Call' }));
  await page.keyboard.press('Enter');
  const count = page.getByRole('navigation', { name: 'Functions' }).getByRole('button', { name: 'count' });
  await expect(count).toBeVisible();
  await tabTo(page, count);
  await page.keyboard.press('Enter');
  await tabTo(page, page.getByRole('button', { name: 'Run' }));
  await page.keyboard.press('Enter');
  // Focus lands on the result's heading.
  await expect(page.getByRole('article', { name: 'Read: count' }).getByRole('heading', { name: 'Read' })).toBeFocused();

  await tabTo(page, page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Cycle' }));
  await page.keyboard.press('Enter');
  const first = page.getByRole('option').first();
  await tabTo(page, first);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('region', { name: 'Differences in increment' })).toBeVisible();
});
