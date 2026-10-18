import { test, expect } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './a11y';

/**
 * Acceptance tests for diagram keyboard navigation (#501, backlog E-21).
 *
 * Requirements:
 * - Walks from the first function -> its first type -> back, asserting
 *   `document.activeElement`'s `data-node-id` at each step.
 * - Arrow navigation follows columns (Up/Down) and edges (Right/Left).
 * - Cycling on repeat Right arrow presses across multiple outgoing edges.
 * - Home and End jump to the first and last node.
 * - With JS disabled, Tab still reaches every node (no roving tabindex applied).
 */

const DIAGRAM_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Diagram Keyboard Navigation Test</title>
  <style>
    :root {
      --viz-focus: #60a5fa;
      --viz-muted: #9e9a8f;
      --viz-node: #181614;
      --viz-edge: #736e62;
      --viz-node-text: #f5f4ee;
    }
    body {
      background: #0a0908;
      color: #f5f4ee;
      font-family: ui-monospace, monospace;
      padding: 24px;
    }
    .contract-diagram [data-node-id]:focus,
    .contract-diagram [data-node-id]:focus-visible,
    .contract-diagram .viz-node--focused {
      outline: 2px solid var(--viz-focus, #60a5fa);
      outline-offset: 3px;
    }
    .contract-diagram [data-node-id]:focus rect,
    .contract-diagram [data-node-id]:focus-visible rect,
    .contract-diagram .viz-node--focused rect {
      stroke: var(--viz-focus, #60a5fa);
      stroke-width: 2.5;
    }
    .viz-keyboard-hint {
      display: inline-block;
      color: var(--viz-muted, #9e9a8f);
      font-family: ui-monospace, monospace;
      font-size: 11px;
      line-height: 1.4;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--viz-node, #181614);
      border: 1px solid var(--viz-edge, #736e62);
      margin-top: 6px;
    }
    .viz-keyboard-hint[hidden] {
      display: none;
    }
  </style>
</head>
<body>
  <div id="diagram-wrapper">
    <svg class="contract-diagram" role="graphics-document" aria-label="Contract Diagram" xmlns="http://www.w3.org/2000/svg" width="600" height="400">
      <title id="diag-title">Contract Diagram</title>
      <defs>
        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
          <path d="M0,0 L10,3.5 L0,7 Z" fill="#736e62" />
        </marker>
      </defs>

      <!-- Edges -->
      <line class="diagram-edge" data-edge-from="fn:claim" data-edge-to="type:Address" x1="150" y1="64" x2="250" y2="64" marker-end="url(#arrowhead)" />
      <line class="diagram-edge" data-edge-from="fn:claim" data-edge-to="type:Signature" x1="150" y1="64" x2="250" y2="164" marker-end="url(#arrowhead)" />
      <line class="diagram-edge" data-edge-from="fn:resolve" data-edge-to="type:Address" x1="150" y1="164" x2="250" y2="64" marker-end="url(#arrowhead)" />

      <!-- Column 0: Functions (x=50) -->
      <a href="#fn-claim" data-node-id="fn:claim">
        <rect class="diagram-node diagram-node--function" x="50" y="50" width="100" height="28" rx="4" ry="4" fill="#181614" stroke="#736e62" />
        <title>claim()</title>
        <text x="100" y="68" fill="#f5f4ee" text-anchor="middle" font-size="12">claim</text>
      </a>

      <a href="#fn-resolve" data-node-id="fn:resolve">
        <rect class="diagram-node diagram-node--function" x="50" y="150" width="100" height="28" rx="4" ry="4" fill="#181614" stroke="#736e62" />
        <title>resolve()</title>
        <text x="100" y="168" fill="#f5f4ee" text-anchor="middle" font-size="12">resolve</text>
      </a>

      <!-- Column 1: Types (x=250) -->
      <a href="#type-Address" data-node-id="type:Address">
        <rect class="diagram-node diagram-node--type" x="250" y="50" width="100" height="28" rx="4" ry="4" fill="#181614" stroke="#736e62" />
        <title>Address</title>
        <text x="300" y="68" fill="#f5f4ee" text-anchor="middle" font-size="12">Address</text>
      </a>

      <a href="#type-Signature" data-node-id="type:Signature">
        <rect class="diagram-node diagram-node--type" x="250" y="150" width="100" height="28" rx="4" ry="4" fill="#181614" stroke="#736e62" />
        <title>Signature</title>
        <text x="300" y="168" fill="#f5f4ee" text-anchor="middle" font-size="12">Signature</text>
      </a>
    </svg>
  </div>

  <script>
    function enhanceKeyboardInPage(svg) {
      if (svg.getAttribute('data-keyboard-enhanced') === 'true') return () => {};
      svg.setAttribute('data-keyboard-enhanced', 'true');

      const doc = svg.ownerDocument;
      const nodeElements = Array.from(svg.querySelectorAll('[data-node-id]'));
      if (nodeElements.length === 0) return () => {};

      const edgeElements = Array.from(svg.querySelectorAll('[data-edge-from]'));
      const outgoingMap = new Map();
      const incomingMap = new Map();

      for (const el of edgeElements) {
        const from = el.getAttribute('data-edge-from');
        const to = el.getAttribute('data-edge-to');
        if (from && to) {
          if (!outgoingMap.has(from)) outgoingMap.set(from, []);
          outgoingMap.get(from).push(to);
          if (!incomingMap.has(to)) incomingMap.set(to, []);
          incomingMap.get(to).push(from);
        }
      }

      const nodeMap = new Map();
      for (const el of nodeElements) {
        const id = el.getAttribute('data-node-id');
        if (id) nodeMap.set(id, el);
      }

      // Group into columns by x
      const spatials = nodeElements.map((el) => {
        const rect = el.querySelector('rect') || el;
        const x = parseFloat(rect.getAttribute('x') || '0');
        const y = parseFloat(rect.getAttribute('y') || '0');
        return { el, x, y };
      });
      spatials.sort((a, b) => a.x - b.x || a.y - b.y);

      const columns = [];
      for (const item of spatials) {
        const lastCol = columns[columns.length - 1];
        if (lastCol && Math.abs(item.x - lastCol[0].x) <= 20) {
          lastCol.push(item);
        } else {
          columns.push([item]);
        }
      }
      for (const col of columns) col.sort((a, b) => a.y - b.y);

      const nodeColIdx = new Map();
      const nodeRowIdx = new Map();
      for (let c = 0; c < columns.length; c++) {
        for (let r = 0; r < columns[c].length; r++) {
          const el = columns[c][r].el;
          nodeColIdx.set(el, c);
          nodeRowIdx.set(el, r);
        }
      }

      const allNodes = columns.flatMap((col) => col.map((i) => i.el));

      // Roving tabindex setup
      let activeNode = allNodes[0];
      activeNode.setAttribute('tabindex', '0');
      for (let i = 1; i < allNodes.length; i++) {
        allNodes[i].setAttribute('tabindex', '-1');
      }

      // Hint element
      const hint = doc.createElement('div');
      hint.className = 'viz-keyboard-hint';
      hint.textContent = 'Keyboard: arrows move, Enter opens';
      hint.hidden = true;
      hint.setAttribute('role', 'status');
      hint.setAttribute('aria-live', 'polite');
      (svg.parentElement || doc.body).appendChild(hint);

      const cycleMap = new Map();
      const incomingHistory = new Map();

      let focusing = false;
      function focusNode(target) {
        const isAlreadyFocused = activeNode === target && target.getAttribute('tabindex') === '0';
        if (activeNode && activeNode !== target) {
          activeNode.setAttribute('tabindex', '-1');
          activeNode.classList.remove('viz-node--focused');
        }
        activeNode = target;
        activeNode.setAttribute('tabindex', '0');
        activeNode.classList.add('viz-node--focused');
        hint.hidden = false;

        if (!isAlreadyFocused && !focusing && typeof target.focus === 'function') {
          try {
            focusing = true;
            target.focus();
          } finally {
            focusing = false;
          }
        }
      }

      function onKeyDown(e) {
        const current = activeNode;
        if (!current) return;

        switch (e.key) {
          case 'ArrowUp': {
            const c = nodeColIdx.get(current);
            const r = nodeRowIdx.get(current);
            if (c !== undefined && r !== undefined) {
              const col = columns[c];
              focusNode(col[Math.max(0, r - 1)].el);
              e.preventDefault();
            }
            break;
          }
          case 'ArrowDown': {
            const c = nodeColIdx.get(current);
            const r = nodeRowIdx.get(current);
            if (c !== undefined && r !== undefined) {
              const col = columns[c];
              focusNode(col[Math.min(col.length - 1, r + 1)].el);
              e.preventDefault();
            }
            break;
          }
          case 'ArrowRight': {
            const id = current.getAttribute('data-node-id');
            const targets = id ? (outgoingMap.get(id) || []) : [];
            if (targets.length > 0) {
              const cycle = cycleMap.get(id) || 0;
              const targetId = targets[cycle % targets.length];
              cycleMap.set(id, cycle + 1);
              incomingHistory.set(targetId, id);
              const targetEl = nodeMap.get(targetId);
              if (targetEl) {
                focusNode(targetEl);
                e.preventDefault();
              }
            }
            break;
          }
          case 'ArrowLeft': {
            const id = current.getAttribute('data-node-id');
            let prevId = id ? incomingHistory.get(id) : undefined;
            if (!prevId && id) {
              const sources = incomingMap.get(id) || [];
              if (sources.length > 0) prevId = sources[0];
            }
            if (prevId) {
              const prevEl = nodeMap.get(prevId);
              if (prevEl) {
                focusNode(prevEl);
                e.preventDefault();
              }
            }
            break;
          }
          case 'Home': {
            if (allNodes.length > 0) {
              focusNode(allNodes[0]);
              e.preventDefault();
            }
            break;
          }
          case 'End': {
            if (allNodes.length > 0) {
              focusNode(allNodes[allNodes.length - 1]);
              e.preventDefault();
            }
            break;
          }
          case 'Enter': {
            if (current.tagName.toLowerCase() === 'a' || current.hasAttribute('href')) {
              if (typeof current.click === 'function') current.click();
            }
            break;
          }
        }
      }

      for (const nodeEl of nodeElements) {
        nodeEl.addEventListener('keydown', onKeyDown);
        nodeEl.addEventListener('focus', () => focusNode(nodeEl));
        nodeEl.addEventListener('blur', () => {
          nodeEl.classList.remove('viz-node--focused');
        });
      }
    }

    const svgEl = document.querySelector('svg.contract-diagram');
    if (svgEl) enhanceKeyboardInPage(svgEl);
  </script>
</body>
</html>`;

test.describe('diagram keyboard navigation (#501)', () => {
  test('walks from the first function -> its first type -> back', async ({ page }) => {
    await page.setContent(DIAGRAM_HTML);

    // Tab into diagram to focus first node (fn:claim)
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('fn:claim');

    // Keyboard hint is shown on focus
    const hint = page.locator('.viz-keyboard-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('Keyboard: arrows move, Enter opens');

    // -> follows first outgoing edge to its first type (type:Address)
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('type:Address');

    // <- goes back along the incoming edge to the first function (fn:claim)
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('fn:claim');

    // Verify cycling: -> again moves to second outgoing edge (type:Signature)
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('type:Signature');

    // <- back to fn:claim
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('fn:claim');

    // Column movement: Down moves to fn:resolve in Column 0
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('fn:resolve');

    // Up moves back to fn:claim
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('fn:claim');

    // Home / End jumps
    await page.keyboard.press('End');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('type:Signature');

    await page.keyboard.press('Home');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'))).toBe('fn:claim');

    await expectNoSeriousA11yViolations(page, 'Diagram keyboard navigation');
  });

  test('with JS disabled, Tab still reaches every node (no roving tabindex applied)', async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.setContent(DIAGRAM_HTML);

    // When JS is disabled, roving tabindex is not applied:
    // every node retains normal tab stop order
    const expectedNodeIds = ['fn:claim', 'fn:resolve', 'type:Address', 'type:Signature'];

    for (const expectedId of expectedNodeIds) {
      await page.keyboard.press('Tab');
      const activeId = await page.evaluate(() => document.activeElement?.getAttribute('data-node-id'));
      expect(activeId).toBe(expectedId);
    }

    await context.close();
  });
});
