import { test, expect } from '@playwright/test';
import { CONTRACT_A, FIXTURE_HANDLE } from './fixtures/contracts';

/**
 * Contract page performance budget (#661).
 *
 * The static half of the budget lives in `scripts/check-route-budgets.mjs`,
 * which fails CI when a route's first-load JS grows past its declared cap. This
 * is the runtime half: on a throttled connection, the Overview and Diagram tabs
 * must still hit a Largest Contentful Paint under 2.5 s and a Cumulative Layout
 * Shift under 0.1, the Core Web Vitals "good" thresholds.
 *
 * Tagged `@db` because it uses the contract-page fixture and therefore only
 * runs in the `e2e-linked` job (the `e2e` job runs `--grep-invert @db`).
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

const base = `/p/${FIXTURE_HANDLE}/contract/${CONTRACT_A}`;

const TABS = [
  { name: 'Overview', path: '' },
  { name: 'Diagram', path: '/diagram' },
] as const;

/**
 * Chrome DevTools' "Fast 3G" preset: values are bytes per second for the
 * throughputs and milliseconds for the round-trip latency.
 */
const FAST_3G = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 562.5,
};

type WebVitals = { __lcp: number; __cls: number };

test.describe('contract page performance @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL: the fixture contract only exists with a database');

  test('Overview and Diagram meet the LCP and CLS budget on Fast 3G', async ({ page, context }) => {
    // Metrics must be observed from the first paint, so the observers are
    // installed before any navigation.
    await page.addInitScript(() => {
      const w = window as unknown as WebVitals;
      w.__lcp = 0;
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          w.__lcp = Math.max(w.__lcp, entry.startTime);
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!shift.hadRecentInput) {
            w.__cls += shift.value;
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', FAST_3G);

    for (const tab of TABS) {
      await page.goto(`${base}${tab.path}`, { waitUntil: 'load' });
      // Let late layout shifts and the largest paint settle before reading.
      await page.waitForTimeout(3000);

      const metrics = await page.evaluate(() => {
        const w = window as unknown as WebVitals;
        return { lcp: w.__lcp, cls: w.__cls };
      });

      expect.soft(metrics.lcp, `${tab.name}: LCP (ms)`).toBeLessThan(2500);
      expect.soft(metrics.cls, `${tab.name}: CLS`).toBeLessThan(0.1);
    }
  });
});
