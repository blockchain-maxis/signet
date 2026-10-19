import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * A serious or critical axe finding that is accepted for now.
 */
export interface KnownViolation {
  /** The axe rule id, for example `color-contrast`. */
  id: string;
  /** Why it is accepted, and the issue tracking its removal. */
  reason: string;
}

/**
 * Accepted findings (#659). This list may shrink but must not grow without
 * review: every entry is a decision to ship a known accessibility barrier, so
 * adding one needs the same scrutiny as the code that caused it. Each entry
 * names the issue tracking its removal.
 */
export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [];

// The existing footer wordmark is non-interactive, aria-hidden background
// texture, duplicated by the accessible Signet link above it. WCAG 1.4.3
// exempts pure decoration. The landing spec guards this exact exception so
// content or controls cannot silently enter the excluded layer.
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
export const DECORATIVE_FOOTER_WORDMARK =
  'footer > [aria-hidden="true"].pointer-events-none > .whitespace-nowrap';

/**
 * Shared axe helper for the e2e specs (#461; #659 asks for the same thing).
 *
 * Fails on `serious` and `critical` violations only — the bar the accessibility
 * issues set. `moderate`/`minor` findings are not asserted; they are attached
 * to the failure message so they are visible without blocking. Rule ids named
 * in `KNOWN_VIOLATIONS` are accepted, with a link to the issue that removes
 * them.
 */
export async function expectNoSeriousA11yViolations(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .exclude(DECORATIVE_FOOTER_WORDMARK)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const accepted = new Set(KNOWN_VIOLATIONS.map((v) => v.id));
  const blocking = violations.filter(
    (v) => (v.impact === 'serious' || v.impact === 'critical') && !accepted.has(v.id),
  );
  expect(
    blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      summary: v.nodes.map((n) => n.failureSummary),
      targets: v.nodes.map((n) => n.target.join(' ')),
    })),
    `${label}: serious/critical axe violations`,
  ).toEqual([]);
}
