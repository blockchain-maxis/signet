/**
 * @file Tests for keyboard navigation across the diagram (#501).
 *
 * Exercises roving tabindex, arrow navigation, edge cycling, history,
 * Home/End jumps, Enter activation, visible focus styling, and the
 * keyboard hint announcement under a minimal DOM double.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYBOARD_CLASSES,
  KEYBOARD_HINT_TEXT,
  buildNavigationMaps,
  enhanceKeyboard,
  getNodePosition,
  groupNodesIntoColumns,
} from './keyboard.ts';

// ---------------------------------------------------------------------------
// Minimal DOM double for keyboard interaction tests
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
  hidden = false;
  id = '';
  rect: FakeRect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  clicked = false;
  private ownText = '';
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
    if (name === 'id') this.id = value;
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
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

  remove(): void {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }

  getBoundingClientRect(): FakeRect {
    return this.rect;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === 'rect') {
      const walk = (el: FakeElement): FakeElement | null => {
        for (const child of el.children) {
          if (child.tagName === 'RECT') return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const match = /^\[([a-z-]+)\]$/.exec(selector);
    const attr = match ? match[1]! : null;
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (attr && child.attributes.has(attr)) out.push(child);
        else if (selector === 'rect' && child.tagName === 'RECT') out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  contains(other: FakeElement | null): boolean {
    if (!other) return false;
    let curr: FakeElement | null = other;
    while (curr) {
      if (curr === this) return true;
      curr = curr.parentElement;
    }
    return false;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
    this.fire('focus');
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
    this.fire('blur');
  }

  click(): void {
    this.clicked = true;
    this.fire('click');
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

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;

  constructor() {
    this.body = new FakeElement('body', this);
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

// ---------------------------------------------------------------------------
// Helpers for test setup
// ---------------------------------------------------------------------------

interface DiagramSetup {
  doc: FakeDocument;
  svg: FakeElement;
  nodes: Record<string, FakeElement>;
  edges: FakeElement[];
}

function createTestDiagram(): DiagramSetup {
  const doc = new FakeDocument();
  const svg = doc.createElement('svg');
  doc.body.appendChild(svg);

  // Layout structure:
  // Column 0 (x=50): fn:claim (y=50), fn:resolve (y=150)
  // Column 1 (x=250): type:Address (y=50), type:Signature (y=150)
  // Column 2 (x=450): type:Bytes (y=50)
  //
  // Edges:
  // fn:claim -> type:Address
  // fn:claim -> type:Signature (multiple outgoing targets from fn:claim)
  // fn:resolve -> type:Address
  // type:Address -> type:Bytes

  const nodeSpecs = [
    { id: 'fn:claim', x: 50, y: 50, href: '/p/alice/contract/C1/functions#fn-claim' },
    { id: 'fn:resolve', x: 50, y: 150, href: '/p/alice/contract/C1/functions#fn-resolve' },
    { id: 'type:Address', x: 250, y: 50, href: '/p/alice/contract/C1/types#type-Address' },
    { id: 'type:Signature', x: 250, y: 150, href: '/p/alice/contract/C1/types#type-Signature' },
    { id: 'type:Bytes', x: 450, y: 50, href: '/p/alice/contract/C1/types#type-Bytes' },
  ];

  const nodes: Record<string, FakeElement> = {};
  for (const spec of nodeSpecs) {
    const a = doc.createElement('a');
    a.setAttribute('data-node-id', spec.id);
    a.setAttribute('href', spec.href);
    a.rect = { left: spec.x, top: spec.y, right: spec.x + 80, bottom: spec.y + 30, width: 80, height: 30 };

    const rect = doc.createElement('rect');
    rect.setAttribute('x', String(spec.x));
    rect.setAttribute('y', String(spec.y));
    a.appendChild(rect);

    svg.appendChild(a);
    nodes[spec.id] = a;
  }

  const edgeSpecs = [
    { from: 'fn:claim', to: 'type:Address' },
    { from: 'fn:claim', to: 'type:Signature' },
    { from: 'fn:resolve', to: 'type:Address' },
    { from: 'type:Address', to: 'type:Bytes' },
  ];

  const edges: FakeElement[] = [];
  for (const edge of edgeSpecs) {
    const line = doc.createElement('line');
    line.setAttribute('data-edge-from', edge.from);
    line.setAttribute('data-edge-to', edge.to);
    svg.appendChild(line);
    edges.push(line);
  }

  return { doc, svg, nodes, edges };
}

function keyEvent(key: string): { key: string; defaultPrevented: boolean; preventDefault: () => void } {
  const ev = {
    key,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
  };
  return ev;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('groupNodesIntoColumns: sorts into columns by x and items by y', () => {
  const { nodes } = createTestDiagram();
  const allList = Object.values(nodes);
  const cols = groupNodesIntoColumns(allList as unknown as Element[], 20);

  assert.equal(cols.length, 3);
  // Column 0 (x=50): fn:claim (y=50), fn:resolve (y=150)
  assert.equal(cols[0]![0]?.getAttribute('data-node-id'), 'fn:claim');
  assert.equal(cols[0]![1]?.getAttribute('data-node-id'), 'fn:resolve');

  // Column 1 (x=250): type:Address (y=50), type:Signature (y=150)
  assert.equal(cols[1]![0]?.getAttribute('data-node-id'), 'type:Address');
  assert.equal(cols[1]![1]?.getAttribute('data-node-id'), 'type:Signature');

  // Column 2 (x=450): type:Bytes (y=50)
  assert.equal(cols[2]![0]?.getAttribute('data-node-id'), 'type:Bytes');
});

test('buildNavigationMaps: creates outgoing and incoming adjacency lists', () => {
  const edges = [
    { from: 'fn:claim', to: 'type:Address' },
    { from: 'fn:claim', to: 'type:Signature' },
    { from: 'fn:resolve', to: 'type:Address' },
  ];
  const maps = buildNavigationMaps(edges);
  assert.deepEqual(maps.outgoing.get('fn:claim'), ['type:Address', 'type:Signature']);
  assert.deepEqual(maps.outgoing.get('fn:resolve'), ['type:Address']);
  assert.deepEqual(maps.incoming.get('type:Address'), ['fn:claim', 'fn:resolve']);
});

test('initial enhancement: sets roving tabindex (first node 0, rest -1) and attaches hint', () => {
  const { svg, nodes, doc } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  // First node in first column has tabindex="0"
  assert.equal(nodes['fn:claim']?.getAttribute('tabindex'), '0');
  // All other nodes have tabindex="-1"
  assert.equal(nodes['fn:resolve']?.getAttribute('tabindex'), '-1');
  assert.equal(nodes['type:Address']?.getAttribute('tabindex'), '-1');
  assert.equal(nodes['type:Signature']?.getAttribute('tabindex'), '-1');
  assert.equal(nodes['type:Bytes']?.getAttribute('tabindex'), '-1');

  // Hint element is created and attached
  const hint = doc.body.children.find((c) => c.classList.contains(KEYBOARD_CLASSES.hint));
  assert.ok(hint, 'hint element should exist');
  assert.equal(hint.textContent, KEYBOARD_HINT_TEXT);
  assert.equal(hint.hidden, true);
  assert.equal(hint.getAttribute('role'), 'status');

  // aria-describedby on the initial node references the hint
  assert.match(nodes['fn:claim']?.getAttribute('aria-describedby') ?? '', new RegExp(hint.id));

  teardown();
});

test('focusing node displays the hint and applies focused class', () => {
  const { svg, nodes, doc } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  const claimNode = nodes['fn:claim']!;
  claimNode.focus();

  const hint = doc.body.children.find((c) => c.classList.contains(KEYBOARD_CLASSES.hint))!;
  assert.equal(hint.hidden, false);
  assert.ok(claimNode.classList.contains(KEYBOARD_CLASSES.focused));

  teardown();
});

test('ArrowDown and ArrowUp navigate within the same column and clamp at boundaries', () => {
  const { svg, nodes } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  const claimNode = nodes['fn:claim']!;
  const resolveNode = nodes['fn:resolve']!;

  claimNode.focus();

  // ArrowUp at top of column clamps
  const upAtTop = keyEvent('ArrowUp');
  claimNode.fire('keydown', upAtTop);
  assert.equal(claimNode.getAttribute('tabindex'), '0');
  assert.equal(resolveNode.getAttribute('tabindex'), '-1');
  assert.equal(upAtTop.defaultPrevented, true);

  // ArrowDown moves to next node in same column
  const downEv = keyEvent('ArrowDown');
  claimNode.fire('keydown', downEv);
  assert.equal(claimNode.getAttribute('tabindex'), '-1');
  assert.equal(resolveNode.getAttribute('tabindex'), '0');
  assert.equal(downEv.defaultPrevented, true);

  // ArrowDown at bottom of column clamps
  const downAtBottom = keyEvent('ArrowDown');
  resolveNode.fire('keydown', downAtBottom);
  assert.equal(resolveNode.getAttribute('tabindex'), '0');
  assert.equal(downAtBottom.defaultPrevented, true);

  // ArrowUp moves back up to claimNode
  const upEv = keyEvent('ArrowUp');
  resolveNode.fire('keydown', upEv);
  assert.equal(claimNode.getAttribute('tabindex'), '0');
  assert.equal(resolveNode.getAttribute('tabindex'), '-1');
  assert.equal(upEv.defaultPrevented, true);

  teardown();
});

test('ArrowRight follows outgoing edge and cycles through multiple edges', () => {
  const { svg, nodes } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  const claimNode = nodes['fn:claim']!;
  const addressNode = nodes['type:Address']!;
  const signatureNode = nodes['type:Signature']!;

  claimNode.focus();

  // First ArrowRight follows first outgoing edge (to type:Address)
  const right1 = keyEvent('ArrowRight');
  claimNode.fire('keydown', right1);
  assert.equal(addressNode.getAttribute('tabindex'), '0');
  assert.equal(claimNode.getAttribute('tabindex'), '-1');
  assert.equal(right1.defaultPrevented, true);

  // Navigate back to claimNode
  claimNode.focus();

  // Second ArrowRight cycles to second outgoing edge (to type:Signature)
  const right2 = keyEvent('ArrowRight');
  claimNode.fire('keydown', right2);
  assert.equal(signatureNode.getAttribute('tabindex'), '0');
  assert.equal(claimNode.getAttribute('tabindex'), '-1');
  assert.equal(right2.defaultPrevented, true);

  // Navigate back to claimNode
  claimNode.focus();

  // Third ArrowRight cycles back to first outgoing edge (type:Address)
  const right3 = keyEvent('ArrowRight');
  claimNode.fire('keydown', right3);
  assert.equal(addressNode.getAttribute('tabindex'), '0');
  assert.equal(right3.defaultPrevented, true);

  teardown();
});

test('ArrowLeft goes back along the incoming edge / navigation history', () => {
  const { svg, nodes } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  const claimNode = nodes['fn:claim']!;
  const addressNode = nodes['type:Address']!;
  const bytesNode = nodes['type:Bytes']!;

  // Walk: fn:claim -> type:Address -> type:Bytes
  claimNode.focus();
  claimNode.fire('keydown', keyEvent('ArrowRight'));
  assert.equal(addressNode.getAttribute('tabindex'), '0');

  addressNode.fire('keydown', keyEvent('ArrowRight'));
  assert.equal(bytesNode.getAttribute('tabindex'), '0');

  // Walk back: type:Bytes -> type:Address -> fn:claim
  const left1 = keyEvent('ArrowLeft');
  bytesNode.fire('keydown', left1);
  assert.equal(addressNode.getAttribute('tabindex'), '0');
  assert.equal(left1.defaultPrevented, true);

  const left2 = keyEvent('ArrowLeft');
  addressNode.fire('keydown', left2);
  assert.equal(claimNode.getAttribute('tabindex'), '0');
  assert.equal(left2.defaultPrevented, true);

  teardown();
});

test('Home and End jump to the first and last node in the diagram', () => {
  const { svg, nodes } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  const claimNode = nodes['fn:claim']!;
  const bytesNode = nodes['type:Bytes']!;
  const resolveNode = nodes['fn:resolve']!;

  resolveNode.focus();

  // End jumps to last node (type:Bytes in Column 2)
  const endEv = keyEvent('End');
  resolveNode.fire('keydown', endEv);
  assert.equal(bytesNode.getAttribute('tabindex'), '0');
  assert.equal(endEv.defaultPrevented, true);

  // Home jumps to first node (fn:claim in Column 0)
  const homeEv = keyEvent('Home');
  bytesNode.fire('keydown', homeEv);
  assert.equal(claimNode.getAttribute('tabindex'), '0');
  assert.equal(homeEv.defaultPrevented, true);

  teardown();
});

test('Enter follows the link by triggering click on the anchor element', () => {
  const { svg, nodes } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  const claimNode = nodes['fn:claim']!;
  claimNode.focus();
  assert.equal(claimNode.clicked, false);

  claimNode.fire('keydown', keyEvent('Enter'));
  assert.equal(claimNode.clicked, true);

  teardown();
});

test('teardown restores original tabindices and removes listeners and hint element', () => {
  const { svg, nodes, doc } = createTestDiagram();
  const teardown = enhanceKeyboard(svg as unknown as SVGSVGElement);

  teardown();

  // All nodes have their original tabindices restored (none had tabindex initially)
  for (const node of Object.values(nodes)) {
    assert.equal(node.getAttribute('tabindex'), null);
    assert.equal(node.classList.contains(KEYBOARD_CLASSES.focused), false);
  }

  // Hint element is removed from DOM
  const hint = doc.body.children.find((c) => c.classList.contains(KEYBOARD_CLASSES.hint));
  assert.equal(hint, undefined);

  // SVG attribute is removed
  assert.equal(svg.getAttribute('data-keyboard-enhanced'), null);
});

test('idempotent: enhancing twice returns a no-op', () => {
  const { svg, nodes } = createTestDiagram();
  const teardown1 = enhanceKeyboard(svg as unknown as SVGSVGElement);
  const teardown2 = enhanceKeyboard(svg as unknown as SVGSVGElement);

  // Second call does not mutate or crash
  assert.equal(nodes['fn:claim']?.getAttribute('tabindex'), '0');

  teardown2();
  teardown1();
});
