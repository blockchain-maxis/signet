/**
 * @file Tests for the bounded viewport, zoom steps and pan (#504).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TEXT_PX } from '../metrics.ts';
import {
  DEFAULT_BASE_FONT_PX,
  DEFAULT_MAX_SCALE,
  DEFAULT_VIEWPORT_LABEL,
  VIEWPORT_CLASSES,
  computeZoomSteps,
  enhanceViewport,
} from './viewport.ts';

// ---------------------------------------------------------------------------
// A minimal DOM double modelled for viewport interactions.
// ---------------------------------------------------------------------------

class FakeClassList {
  private readonly tokens = new Set<string>();
  add(...names: string[]): void {
    for (const n of names) this.tokens.add(n);
  }
  remove(...names: string[]): void {
    for (const n of names) this.tokens.delete(n);
  }
  contains(name: string): boolean {
    return this.tokens.has(name);
  }
  toString(): string {
    return [...this.tokens].join(' ');
  }
}

class FakeStyle {
  position = '';
  overflow = '';
  maxHeight = '';
  maxWidth = '';
  boxSizing = '';
  scrollBehavior = '';
  transform = '';
  transformOrigin = '';
  transition = '';
  marginRight = '';
  marginBottom = '';
  setProperty(name: string, value: string): void {
    (this as unknown as Record<string, string>)[name] = value;
  }
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  classList = new FakeClassList();
  readonly style = new FakeStyle();
  type = '';
  disabled = false;
  scrollLeft = 0;
  scrollTop = 0;
  private ownText = '';
  scrolledIntoViewWith: unknown = null;
  capturedPointerId: number | null = null;
  releasedPointerId: number | null = null;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(tagName: string, doc: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
  }

  get className(): string {
    return this.classList.toString();
  }
  set className(value: string) {
    this.classList = new FakeClassList();
    for (const token of value.split(/\s+/).filter(Boolean)) this.classList.add(token);
  }

  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'class') this.className = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  prepend(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.unshift(child);
    return child;
  }
  append(...nodes: FakeElement[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }

  scrollIntoView(options?: unknown): void {
    this.scrolledIntoViewWith = options;
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointerId = pointerId;
  }
  releasePointerCapture(pointerId: number): void {
    this.releasedPointerId = pointerId;
  }

  closest(selector: string): FakeElement | null {
    if (selector === 'button' && this.tagName === 'BUTTON') return this;
    if (selector.startsWith('.') && this.classList.contains(selector.slice(1))) return this;
    if (selector === '[data-node-id]' && this.hasAttribute('data-node-id')) return this;
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  querySelector(selector: string): FakeElement | null {
    const walk = (el: FakeElement): FakeElement | null => {
      for (const child of el.children) {
        if (selector.includes('svg') && child.tagName === 'SVG') return child;
        if (selector === 'button' && child.tagName === 'BUTTON') return child;
        if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (selector === 'button' && child.tagName === 'BUTTON') out.push(child);
        if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) out.push(child);
        if (selector === '[data-node-id]' && child.hasAttribute('data-node-id')) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event: { type: string; [key: string]: unknown }): boolean {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const h of handlers) h(event);
    }
    return true;
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
}

function makeFixture() {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  const svg = doc.createElement('svg');
  svg.setAttribute('class', 'contract-diagram');

  const node1 = doc.createElement('g');
  node1.setAttribute('data-node-id', 'fn:claim');
  svg.appendChild(node1);

  const node2 = doc.createElement('g');
  node2.setAttribute('data-node-id', 'fn:resolve');
  svg.appendChild(node2);

  container.appendChild(svg);
  return { doc, container, svg, node1, node2 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('computeZoomSteps calculates discrete steps from minScale to maxScale', () => {
  const steps = computeZoomSteps(14, 1.5);
  // minScale = 12 / 14 ≈ 0.8571428571428571
  const minScale = 12 / 14;
  assert.equal(steps.length, 4);
  assert.ok(Math.abs(steps[0]! - minScale) < 0.0001);
  assert.equal(steps[1], 1.0);
  assert.equal(steps[2], 1.25);
  assert.equal(steps[3], 1.5);

  // At the smallest step, node text of 14px renders at >= 12px
  const smallestRenderedPx = 14 * steps[0]!;
  assert.ok(smallestRenderedPx >= MIN_TEXT_PX);
});

test('computeZoomSteps respects custom baseFontPx and bounds', () => {
  // If baseFontPx = 12, minScale = 12/12 = 1.0
  const steps12 = computeZoomSteps(12, 1.5);
  assert.deepEqual(steps12, [1.0, 1.25, 1.5]);

  // If baseFontPx = 16, minScale = 12/16 = 0.75
  const steps16 = computeZoomSteps(16, 1.5);
  assert.equal(steps16[0], 0.75);
  assert.equal(16 * steps16[0]!, 12);
});

test('enhanceViewport configures accessibility and container styles', () => {
  const { container } = makeFixture();
  const controller = enhanceViewport(container as unknown as HTMLElement);

  assert.equal(container.getAttribute('role'), 'region');
  assert.equal(container.getAttribute('aria-label'), DEFAULT_VIEWPORT_LABEL);
  assert.equal(container.getAttribute('tabindex'), '0');
  assert.equal(container.classList.contains(VIEWPORT_CLASSES.container), true);
  assert.equal(container.style.overflow, 'auto');
  assert.equal(container.style.maxHeight, '70vh');
  assert.equal(container.style.maxWidth, '100%');
  assert.equal(container.style.boxSizing, 'border-box');
  assert.equal(container.style.scrollBehavior, 'auto');

  controller.teardown();
});

test('enhanceViewport mounts zoom controls with -, 100%, + buttons', () => {
  const { container } = makeFixture();
  const controller = enhanceViewport(container as unknown as HTMLElement);

  const controls = container.querySelector(`.${VIEWPORT_CLASSES.controls}`);
  assert.ok(controls);
  assert.equal(controls.getAttribute('role'), 'toolbar');

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0]!.getAttribute('data-action'), 'zoom-out');
  assert.equal(buttons[0]!.textContent, '−');
  assert.equal(buttons[1]!.getAttribute('data-action'), 'zoom-reset');
  assert.equal(buttons[1]!.textContent, '100%');
  assert.equal(buttons[2]!.getAttribute('data-action'), 'zoom-in');
  assert.equal(buttons[2]!.textContent, '+');

  controller.teardown();
});

test('zoom buttons cycle through discrete steps and update SVG scale', () => {
  const { container, svg } = makeFixture();
  const controller = enhanceViewport(container as unknown as HTMLElement);

  const [btnZoomOut, btnReset, btnZoomIn] = container.querySelectorAll('button');
  assert.ok(btnZoomOut && btnReset && btnZoomIn);

  // Initial step is 1.0 (index 1 of [12/14, 1.0, 1.25, 1.5])
  assert.equal(controller.getScale(), 1.0);
  assert.equal(controller.getStepIndex(), 1);
  assert.equal(btnZoomOut.disabled, false);
  assert.equal(btnZoomIn.disabled, false);
  assert.equal(svg.style.transform, 'scale(1)');

  // Zoom in to 1.25
  btnZoomIn.dispatchEvent({ type: 'click' });
  assert.equal(controller.getScale(), 1.25);
  assert.equal(controller.getStepIndex(), 2);
  assert.equal(svg.style.transform, 'scale(1.25)');

  // Zoom in to 1.5 (max scale)
  btnZoomIn.dispatchEvent({ type: 'click' });
  assert.equal(controller.getScale(), 1.5);
  assert.equal(controller.getStepIndex(), 3);
  assert.equal(btnZoomIn.disabled, true);
  assert.equal(svg.style.transform, 'scale(1.5)');

  // Clicking zoom-in at max scale does nothing
  btnZoomIn.dispatchEvent({ type: 'click' });
  assert.equal(controller.getScale(), 1.5);

  // Zoom reset back to 1.0
  btnReset.dispatchEvent({ type: 'click' });
  assert.equal(controller.getScale(), 1.0);
  assert.equal(controller.getStepIndex(), 1);
  assert.equal(svg.style.transform, 'scale(1)');

  // Zoom out to minScale (12/14)
  btnZoomOut.dispatchEvent({ type: 'click' });
  const minScale = 12 / 14;
  assert.ok(Math.abs(controller.getScale() - minScale) < 0.0001);
  assert.equal(controller.getStepIndex(), 0);
  assert.equal(btnZoomOut.disabled, true);

  // Clicking zoom-out at min scale does nothing
  btnZoomOut.dispatchEvent({ type: 'click' });
  assert.equal(controller.getStepIndex(), 0);

  controller.teardown();
});

test('keyboard shortcuts +, -, 0 while region is focused zoom in, out and reset', () => {
  const { container } = makeFixture();
  const controller = enhanceViewport(container as unknown as HTMLElement);

  // + zooms in
  let prevented = false;
  container.dispatchEvent({
    type: 'keydown',
    key: '+',
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(controller.getScale(), 1.25);

  // = also zooms in
  container.dispatchEvent({
    type: 'keydown',
    key: '=',
    preventDefault: () => {},
  });
  assert.equal(controller.getScale(), 1.5);

  // 0 resets zoom to 1.0
  container.dispatchEvent({
    type: 'keydown',
    key: '0',
    preventDefault: () => {},
  });
  assert.equal(controller.getScale(), 1.0);

  // - zooms out
  container.dispatchEvent({
    type: 'keydown',
    key: '-',
    preventDefault: () => {},
  });
  const minScale = 12 / 14;
  assert.ok(Math.abs(controller.getScale() - minScale) < 0.0001);

  controller.teardown();
});

test('moving focus to a node scrolls it into view with block and inline nearest', () => {
  const { container, node1 } = makeFixture();
  const controller = enhanceViewport(container as unknown as HTMLElement);

  container.dispatchEvent({
    type: 'focusin',
    target: node1,
  });

  assert.deepEqual(node1.scrolledIntoViewWith, { block: 'nearest', inline: 'nearest' });

  controller.teardown();
});

test('pointer events support drag-to-pan updating scrollLeft and scrollTop', () => {
  const { container } = makeFixture();
  const controller = enhanceViewport(container as unknown as HTMLElement);

  container.scrollLeft = 100;
  container.scrollTop = 50;

  // Start drag at (200, 200)
  container.dispatchEvent({
    type: 'pointerdown',
    button: 0,
    clientX: 200,
    clientY: 200,
    pointerId: 1,
    target: container,
  });
  assert.equal(container.capturedPointerId, 1);

  // Move pointer by (-50, -30) -> scroll increases by (+50, +30)
  container.dispatchEvent({
    type: 'pointermove',
    clientX: 150,
    clientY: 170,
  });
  assert.equal(container.scrollLeft, 150);
  assert.equal(container.scrollTop, 80);
  assert.equal(container.classList.contains(VIEWPORT_CLASSES.dragging), true);

  // Release pointer
  container.dispatchEvent({
    type: 'pointerup',
    pointerId: 1,
  });
  assert.equal(container.releasedPointerId, 1);
  assert.equal(container.classList.contains(VIEWPORT_CLASSES.dragging), false);

  controller.teardown();
});

test('enhancing twice is a no-op and teardown cleans up all state', () => {
  const { container } = makeFixture();
  const controller1 = enhanceViewport(container as unknown as HTMLElement);
  const controller2 = enhanceViewport(container as unknown as HTMLElement);

  // Calling twice does not duplicate controls
  const toolbars = container.querySelectorAll(`.${VIEWPORT_CLASSES.controls}`);
  assert.equal(toolbars.length, 1);

  // Teardown cleans up
  controller1.teardown();
  assert.equal(container.hasAttribute('data-viewport-enhanced'), false);
  assert.equal(container.classList.contains(VIEWPORT_CLASSES.container), false);
  assert.equal(container.querySelectorAll(`.${VIEWPORT_CLASSES.controls}`).length, 0);

  // Calling teardown on controller2 is harmless
  controller2.teardown();
});
