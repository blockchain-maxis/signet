/**
 * @file Tests for the hover/focus detail card (#500).
 *
 * The pure helpers (card rows, relations, placement) are exercised directly.
 * The interaction itself runs under a small hand-rolled DOM double rather than
 * jsdom: the enhancer's DOM surface is deliberately narrow, and keeping it
 * that way is part of the design, so a double is enough to prove hover, focus,
 * Escape, `aria-describedby` and the highlight classes. The full browser
 * behaviour (tab order, real geometry, contrast) is the Playwright spec's job
 * (`apps/web/e2e/contract-diagram-details.spec.ts`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GAP,
  DETAILS_CLASSES,
  detailSections,
  enhanceDetails,
  placeCard,
  relatedTo,
  type DetailsData,
} from './details.ts';

// ---------------------------------------------------------------------------
// A minimal DOM double. Only the surface `enhanceDetails` touches is modelled,
// on purpose: if the enhancer grows a dependency this double does not have, the
// test fails loudly rather than silently diverging from the browser.
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
  zIndex = '';
  left = '';
  top = '';
  setProperty(name: string, value: string): void {
    (this as unknown as Record<string, string>)[name] = value;
  }
}

interface FakeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  classList = new FakeClassList();
  readonly style = new FakeStyle();
  hidden = false;
  id = '';
  private ownText = '';
  offsetWidth = 200;
  offsetHeight = 100;
  rect: FakeRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
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

  /** Aggregates descendants, like the spec's `textContent`. */
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
    if (name === 'id') this.id = value;
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
  append(...nodes: FakeElement[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  /** Supports only the two attribute-presence selectors the enhancer uses. */
  querySelectorAll(selector: string): FakeElement[] {
    const match = /^\[([a-z-]+)\]$/.exec(selector);
    assert.ok(match, `fake DOM: unsupported selector ${selector}`);
    const attr = match[1] as string;
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child.attributes.has(attr)) out.push(child);
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
  /** Test-only: fire every handler registered for `type`. */
  fire(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeDocument {
  readonly body: FakeElement;
  readonly defaultView: { innerWidth: number; innerHeight: number };
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(viewport = { innerWidth: 1024, innerHeight: 768 }) {
    this.body = new FakeElement('body', this);
    this.defaultView = viewport;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
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
  fire(type: string, event: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function px(value: number): number {
  return value;
}

interface Scene {
  doc: FakeDocument;
  host: FakeElement;
  svg: FakeElement;
  node(id: string, rect?: Partial<FakeRect>, tag?: string): FakeElement;
  edge(from: string, to: string): FakeElement;
  card(): FakeElement;
}

/**
 * Builds an `<svg>` with the given nodes/edges under a host, mirroring what
 * `renderDiagramSvg` emits: node containers carry `data-node-id`, edges carry
 * `data-edge-from`/`data-edge-to`.
 */
function scene(): Scene {
  const doc = new FakeDocument();
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const svg = doc.createElement('svg');
  host.appendChild(svg);

  return {
    doc,
    host,
    svg,
    node(id, rect, tag = 'g') {
      const el = doc.createElement(tag);
      el.setAttribute('data-node-id', id);
      if (rect) {
        el.rect = {
          left: px(rect.left ?? 0),
          top: px(rect.top ?? 0),
          right: px(rect.right ?? 0),
          bottom: px(rect.bottom ?? 0),
          width: px(rect.width ?? 0),
          height: px(rect.height ?? 0),
        };
      }
      svg.appendChild(el);
      return el;
    },
    edge(from, to) {
      const el = doc.createElement('line');
      el.setAttribute('data-edge-from', from);
      el.setAttribute('data-edge-to', to);
      svg.appendChild(el);
      return el;
    },
    card() {
      const card = host.children.find((c) => c.classList.contains(DETAILS_CLASSES.card));
      assert.ok(card, 'expected a detail card under the host');
      return card;
    },
  };
}

const DATA: DetailsData = {
  'fn:transfer': {
    signature: 'transfer(from: Address, to: Address, amount: i128) -> ()',
    doc: 'Move amount from from to to.',
    types: ['Address', 'i128'],
  },
  'fn:balance': { signature: 'balance(of: Address) -> i128' },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('detailSections leads with the signature and drops empty sections', () => {
  assert.deepEqual(detailSections({ signature: 'f()' }), [{ label: 'Signature', value: 'f()' }]);

  const full = detailSections({
    signature: 'transfer(...)',
    doc: 'Move funds.',
    types: ['Address', 'i128'],
    marks: ['writes'],
  });
  assert.deepEqual(
    full.map((s) => s.label),
    ['Signature', 'Types', 'Doc', 'Marks'],
  );
  assert.equal(full[1]?.value, 'Address, i128');
});

test('detailSections ignores whitespace-only docs and empty lists', () => {
  const rows = detailSections({ signature: 'f()', doc: '   ', types: [], marks: [] });
  assert.deepEqual(
    rows.map((s) => s.label),
    ['Signature'],
  );
});

test('relatedTo returns neighbours and incident edges, and counts a self-loop once', () => {
  const edges = [
    { from: 'fn:a', to: 'type:X' },
    { from: 'fn:b', to: 'fn:a' },
    { from: 'fn:a', to: 'fn:a' }, // self-loop: incident, not a neighbour
    { from: 'fn:c', to: 'type:Y' }, // unrelated
  ];
  const { neighbours, incident } = relatedTo('fn:a', edges);
  assert.deepEqual(neighbours.sort(), ['fn:b', 'type:X']);
  assert.equal(incident.length, 3);
});

test('placeCard prefers the right side, fully clear of the node', () => {
  const node = { left: 100, top: 100, right: 200, bottom: 130, width: 100, height: 30 };
  const card = { width: 240, height: 120 };
  const p = placeCard(node, card, { width: 1024, height: 768 });
  assert.equal(p.side, 'right');
  assert.equal(p.left, node.right + DEFAULT_GAP);
  assert.ok(p.left >= node.right, 'card must not cover the node');
});

test('placeCard flips to the left when there is no room on the right', () => {
  const node = { left: 900, top: 100, right: 1000, bottom: 130, width: 100, height: 30 };
  const card = { width: 240, height: 120 };
  const p = placeCard(node, card, { width: 1024, height: 768 });
  assert.equal(p.side, 'left');
  assert.ok(p.left + card.width <= node.left, 'card must sit clear of the node on the left');
});

test('placeCard drops below a node too wide to sit beside, and stays on screen', () => {
  // Phone width, node spanning almost the whole viewport.
  const node = { left: 8, top: 200, right: 352, bottom: 230, width: 344, height: 30 };
  const card = { width: 240, height: 120 };
  const viewport = { width: 360, height: 640 };
  const p = placeCard(node, card, viewport);
  assert.equal(p.side, 'below');
  assert.ok(p.top >= node.bottom, 'card must not cover the node');
  assert.ok(
    p.left >= DEFAULT_GAP && p.left + card.width <= viewport.width,
    'card must stay on screen',
  );
});

test('placeCard clamps vertically so a tall card stays on screen', () => {
  const node = { left: 100, top: 700, right: 200, bottom: 730, width: 100, height: 30 };
  const card = { width: 240, height: 200 };
  const viewport = { width: 1024, height: 768 };
  const p = placeCard(node, card, viewport);
  assert.ok(p.top >= DEFAULT_GAP && p.top + card.height <= viewport.height);
});

// ---------------------------------------------------------------------------
// Interaction (DOM double)
// ---------------------------------------------------------------------------

test('hovering a node with details shows the card and links it with aria-describedby', () => {
  const s = scene();
  const node = s.node('fn:transfer', { left: 100, top: 100, right: 200, bottom: 130 });
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);
  const card = s.card();

  assert.equal(card.hidden, true);
  node.fire('mouseenter');
  assert.equal(card.hidden, false);
  assert.equal(node.getAttribute('aria-describedby'), card.id);
  assert.equal(card.getAttribute('role'), 'tooltip');
  // The signature is rendered as text, not markup.
  assert.match(card.textContent, /transfer\(from: Address/);
  teardown();
});

test('focus shows the same card and blur hides it', () => {
  const s = scene();
  const node = s.node('fn:transfer', { left: 100, top: 100, right: 200, bottom: 130 });
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);
  const card = s.card();

  node.fire('focus');
  assert.equal(card.hidden, false);
  node.fire('blur');
  assert.equal(card.hidden, true);
  assert.equal(node.getAttribute('aria-describedby'), null);
  teardown();
});

test('Escape dismisses an open card', () => {
  const s = scene();
  const node = s.node('fn:transfer', { left: 100, top: 100, right: 200, bottom: 130 });
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);
  const card = s.card();

  node.fire('mouseenter');
  assert.equal(card.hidden, false);
  s.doc.fire('keydown', { key: 'Escape' });
  assert.equal(card.hidden, true);
  assert.equal(node.getAttribute('aria-describedby'), null);
  teardown();
});

test('a bare <g> node gets a tab stop; an <a> node does not', () => {
  const s = scene();
  const g = s.node('fn:transfer', { left: 0, top: 0, right: 10, bottom: 10 }, 'g');
  const a = s.node('fn:balance', { left: 0, top: 0, right: 10, bottom: 10 }, 'a');
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);

  assert.equal(g.getAttribute('tabindex'), '0');
  assert.equal(a.hasAttribute('tabindex'), false);
  teardown();
});

test('opening highlights incident edges and neighbour nodes, and closing clears them', () => {
  const s = scene();
  const a = s.node('fn:transfer', { left: 100, top: 100, right: 200, bottom: 130 });
  const b = s.node('type:Address', { left: 300, top: 100, right: 400, bottom: 130 });
  const c = s.node('type:i128', { left: 300, top: 200, right: 400, bottom: 230 });
  const ab = s.edge('fn:transfer', 'type:Address');
  const ac = s.edge('fn:transfer', 'type:i128');
  const unrelated = s.edge('fn:other', 'type:Other');
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);

  a.fire('mouseenter');
  assert.equal(a.classList.contains(DETAILS_CLASSES.active), true);
  assert.equal(b.classList.contains(DETAILS_CLASSES.related), true);
  assert.equal(c.classList.contains(DETAILS_CLASSES.related), true);
  assert.equal(ab.classList.contains(DETAILS_CLASSES.incident), true);
  assert.equal(ac.classList.contains(DETAILS_CLASSES.incident), true);
  assert.equal(unrelated.classList.contains(DETAILS_CLASSES.incident), false);

  a.fire('mouseleave');
  assert.equal(a.classList.contains(DETAILS_CLASSES.active), false);
  assert.equal(b.classList.contains(DETAILS_CLASSES.related), false);
  assert.equal(ab.classList.contains(DETAILS_CLASSES.incident), false);
  teardown();
});

test('moves the card between nodes without leaving stale aria links', () => {
  const s = scene();
  const a = s.node('fn:transfer', { left: 100, top: 100, right: 200, bottom: 130 });
  const b = s.node('fn:balance', { left: 100, top: 300, right: 200, bottom: 330 });
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);
  const card = s.card();

  a.fire('focus');
  b.fire('focus');
  assert.equal(a.getAttribute('aria-describedby'), null);
  assert.equal(b.getAttribute('aria-describedby'), card.id);
  teardown();
});

test('nodes absent from the data are left untouched (native title still works)', () => {
  const s = scene();
  const unknown = s.node('fn:mystery', { left: 0, top: 0, right: 10, bottom: 10 });
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);
  assert.equal(unknown.hasAttribute('tabindex'), false);
  unknown.fire('mouseenter');
  assert.equal(s.card().hidden, true);
  teardown();
});

test('enhancing twice is a no-op and the first teardown still wins', () => {
  const s = scene();
  const node = s.node('fn:transfer', { left: 100, top: 100, right: 200, bottom: 130 });
  const first = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);
  assert.equal(s.svg.getAttribute('data-details-enhanced'), 'true');
  const second = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);

  node.fire('mouseenter');
  // Exactly one card, one set of listeners: the second call added nothing.
  const cards = s.host.children.filter((c) => c.classList.contains(DETAILS_CLASSES.card));
  assert.equal(cards.length, 1);
  assert.equal(node.listenerCount('mouseenter'), 1);

  second();
  assert.equal(
    s.svg.getAttribute('data-details-enhanced'),
    'true',
    'second teardown must not undo the first',
  );
  first();
  assert.equal(s.svg.getAttribute('data-details-enhanced'), null);
});

test('teardown removes the card, the document listener and all node listeners', () => {
  const s = scene();
  const node = s.node('fn:transfer', { left: 100, top: 100, right: 200, bottom: 130 });
  const teardown = enhanceDetails(s.svg as unknown as SVGSVGElement, DATA);

  assert.equal(s.doc.listenerCount('keydown'), 1);
  teardown();
  assert.equal(s.doc.listenerCount('keydown'), 0);
  assert.equal(node.listenerCount('mouseenter'), 0);
  assert.equal(
    s.host.children.some((c) => c.classList.contains(DETAILS_CLASSES.card)),
    false,
  );
});
