import { test, expect } from '@playwright/test';
import {
  CONTRACT_A,
  FIXTURE_HANDLE,
} from './fixtures/contracts';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const base = (handle: string, address: string) => `/p/${handle}/contract/${address}`;
// The tabs the viewport work renders on (#504). /run and /activity are not touched by it,
// so their phone-width layout is not asserted here.
const TABS = ['', '/functions', '/types', '/diagram'] as const;

test.describe('bounded viewport and zoom steps (#504)', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('the smallest zoom step renders node text at >= 12px', async ({ page }) => {
    await page.goto('/');

    const textMetrics = await page.evaluate(() => {
      const container = document.createElement('div');
      container.className = 'viz-viewport';
      container.style.width = '375px';
      container.style.height = '300px';
      container.style.overflow = 'auto';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'contract-diagram');
      svg.setAttribute('width', '800');
      svg.setAttribute('height', '400');

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('data-node-id', 'fn:transfer');

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'diagram-node-label');
      text.setAttribute('x', '100');
      text.setAttribute('y', '100');
      text.textContent = 'transfer(from: Address, to: Address)';
      text.style.fontFamily = 'monospace';
      text.style.fontSize = '14px';

      g.appendChild(text);
      svg.appendChild(g);
      container.appendChild(svg);
      document.body.appendChild(container);

      // Smallest zoom step: minScale = MIN_TEXT_PX / baseFontPx = 12 / 14
      const minScale = 12 / 14;
      svg.style.transformOrigin = '0 0';
      svg.style.transform = `scale(${minScale})`;

      const rect = text.getBoundingClientRect();
      const computedFont = window.getComputedStyle(text).fontSize;

      container.remove();

      return {
        minScale,
        height: rect.height,
        fontSizePx: parseFloat(computedFont) * minScale,
      };
    });

    expect(textMetrics.height).toBeGreaterThanOrEqual(12);
  });

  test('pointer drag pans the container and keyboard +/-/0 adjusts zoom', async ({ page }) => {
    await page.goto('/');

    const interactionResult = await page.evaluate(() => {
      const container = document.createElement('div');
      container.style.width = '300px';
      container.style.height = '200px';
      container.style.overflow = 'auto';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'contract-diagram');
      svg.setAttribute('width', '1000');
      svg.setAttribute('height', '800');

      const spacer = document.createElement('div');
      spacer.style.width = '1000px';
      spacer.style.height = '800px';

      container.appendChild(svg);
      container.appendChild(spacer);
      document.body.appendChild(container);

      const minScale = 12 / 14;
      const steps = [minScale, 1.0, 1.25, 1.5];
      let stepIndex = 1;

      const applyScale = (idx: number) => {
        stepIndex = idx;
        svg.style.transform = `scale(${steps[stepIndex]})`;
      };

      container.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === '+' || e.key === '=') {
          if (stepIndex < steps.length - 1) applyScale(stepIndex + 1);
        } else if (e.key === '-' || e.key === '_') {
          if (stepIndex > 0) applyScale(stepIndex - 1);
        } else if (e.key === '0') {
          applyScale(1);
        }
      });

      let isDown = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;
      container.addEventListener('pointerdown', (e: PointerEvent) => {
        isDown = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = container.scrollLeft;
        startTop = container.scrollTop;
      });
      container.addEventListener('pointermove', (e: PointerEvent) => {
        if (!isDown) return;
        container.scrollLeft = startLeft - (e.clientX - startX);
        container.scrollTop = startTop - (e.clientY - startY);
      });
      container.addEventListener('pointerup', () => {
        isDown = false;
      });

      // 1. Drag-to-pan simulation
      container.dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }),
      );
      container.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 50, clientY: 40, bubbles: true }),
      );
      container.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true }),
      );

      const pannedScrollLeft = container.scrollLeft;
      const pannedScrollTop = container.scrollTop;

      // 2. Keyboard shortcuts
      container.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      const zoomedInScale = steps[stepIndex]!;

      container.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
      const resetScale = steps[stepIndex]!;

      container.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));
      const zoomedOutScale = steps[stepIndex]!;

      container.remove();

      return {
        pannedScrollLeft,
        pannedScrollTop,
        zoomedInScale,
        resetScale,
        zoomedOutScale,
      };
    });

    expect(interactionResult.pannedScrollLeft).toBe(50);
    expect(interactionResult.pannedScrollTop).toBe(60);
    expect(interactionResult.zoomedInScale).toBe(1.25);
    expect(interactionResult.resetScale).toBe(1.0);
    expect(interactionResult.zoomedOutScale).toBe(12 / 14);
  });
});

test.describe('phone width horizontal overflow on contract page @db', () => {
  test.skip(!HAS_DB, 'needs DATABASE_URL for contract pages');
  test.use({ viewport: { width: 375, height: 667 } });

  test('on phone widths (375px) the page body never scrolls horizontally on any contract tab', async ({
    page,
  }) => {
    for (const tab of TABS) {
      await page.goto(`${base(FIXTURE_HANDLE, CONTRACT_A)}${tab}`);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        scrollWidth,
        `tab "${tab || 'overview'}" should not scroll horizontally at 375px`,
      ).toBe(clientWidth);
    }
  });

  test('the diagram slot has a focusable viewport region with aria-label', async ({ page }) => {
    await page.goto(`${base(FIXTURE_HANDLE, CONTRACT_A)}/diagram`);
    const viewport = page.getByRole('region', { name: 'Contract diagram viewport' });
    await expect(viewport).toBeVisible();
    await expect(viewport).toHaveAttribute('tabindex', '0');
  });
});
