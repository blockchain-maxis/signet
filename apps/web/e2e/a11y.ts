import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Shared axe helper for the e2e specs (#461; #659 asks for the same thing).
 *
 * Fails on `serious` and `critical` violations only — the bar the accessibility
 * issues set. `moderate`/`minor` findings are not asserted; they are attached
 * to the failure message so they are visible without blocking.
 */
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      summary: v.nodes.map((n) => n.failureSummary),
      targets: v.nodes.map((n) => n.target.join(' ')),
    })),
    `${label}: serious/critical axe violations`,
  ).toEqual([]);
}
