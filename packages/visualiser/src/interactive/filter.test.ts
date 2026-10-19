/**
 * @file Tests for diagram search and filter (#503).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILTER_CLASSES,
  enhanceFilter,
  formatFilterAnnouncement,
} from './filter.ts';
import { renderDiagramSvg } from '../render.ts';
import type { DiagramModel } from '../index.ts';

// ---------------------------------------------------------------------------
// Minimal DOM double for filter tests
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

class FakeNode {
  readonly attributes = new Map<string, string>();
  classList = new FakeClassList();
  parentElement: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  focused = false;
  value = '';
  private ownText = '';
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    if (this.children.length === 0) return this.ownText;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(val: string) {
    this.ownText = val;
    this.children.length = 0;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'class') {
      this.classList = new FakeClassList();
      for (const tok of value.split(/\s+/).filter(Boolean)) {
        this.classList.add(tok);
      }
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  focus(): void {
    this.focused = true;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: { type: string; [key: string]: unknown }): void {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const fn of set) fn(event);
    }
  }

  querySelectorAll<T = FakeNode>(selector: string): T[] {
    const results: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      for (const child of node.children) {
        if (selector === '[data-node-id]' && child.attributes.has('data-node-id')) {
          results.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return results as unknown as T[];
  }

  querySelector<T = FakeNode>(selector: string): T | null {
    if (selector === '[data-node-id]:not(.viz-dimmed)') {
      const walk = (node: FakeNode): FakeNode | null => {
        for (const child of node.children) {
          if (child.attributes.has('data-node-id') && !child.classList.contains('viz-dimmed')) {
            return child;
          }
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(this) as unknown as T | null;
    }
    return null;
  }
}

test('formatFilterAnnouncement: formats matching messages and empty state', () => {
  assert.equal(formatFilterAnnouncement(1, 8, 1), '1 of 8 functions match');
  assert.equal(formatFilterAnnouncement(3, 42, 3), '3 of 42 functions match');
  assert.equal(formatFilterAnnouncement(0, 8, 0), 'No functions or types match');
});

test('enhanceFilter: typing claim leaves 1 highlighted node, announces 1 of 8 functions match, Enter focuses it', () => {
  const container = new FakeNode('DIV');
  const input = new FakeNode('INPUT');
  const liveRegion = new FakeNode('DIV');
  liveRegion.setAttribute('aria-live', 'polite');

  container.appendChild(input);
  container.appendChild(liveRegion);

  const functionNames = ['claim', 'transfer', 'balance', 'mint', 'burn', 'allowance', 'approve', 'lock'];
  const nodes: FakeNode[] = [];

  for (const name of functionNames) {
    const nodeEl = new FakeNode('G');
    nodeEl.setAttribute('data-node-id', `fn:${name}`);
    const textEl = new FakeNode('TEXT');
    textEl.textContent = name;
    nodeEl.appendChild(textEl);
    container.appendChild(nodeEl);
    nodes.push(nodeEl);
  }

  const controller = enhanceFilter({
    container: container as unknown as HTMLElement,
    input: input as unknown as HTMLInputElement,
    liveRegion: liveRegion as unknown as HTMLElement,
  });

  // Type "claim"
  input.value = 'claim';
  input.dispatchEvent({ type: 'input', target: input });

  assert.equal(liveRegion.textContent, '1 of 8 functions match');
  assert.ok(nodes[0]!.classList.contains(FILTER_CLASSES.match));
  assert.equal(nodes[0]!.classList.contains(FILTER_CLASSES.dimmed), false);

  for (let i = 1; i < nodes.length; i++) {
    assert.ok(nodes[i]!.classList.contains(FILTER_CLASSES.dimmed));
    assert.equal(nodes[i]!.classList.contains(FILTER_CLASSES.match), false);
  }

  // Press Enter
  input.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault() {},
  });

  assert.equal(nodes[0]!.focused, true);

  // Type query with no matches
  input.value = 'nonexistent';
  input.dispatchEvent({ type: 'input', target: input });

  assert.equal(liveRegion.textContent, 'No functions or types match');
  for (const n of nodes) {
    assert.ok(n.classList.contains(FILTER_CLASSES.dimmed));
  }

  controller.destroy();
});

test('renderDiagramSvg: server-side query applies viz-dimmed to non-matches and emits anchor id', () => {
  const model: DiagramModel = {
    nodes: [
      { id: 'fn:claim', label: 'claim' },
      { id: 'fn:swap', label: 'swap' },
      { id: 'type:Address', label: 'Address' },
    ],
    edges: [],
  };

  const svg = renderDiagramSvg(model, {
    idPrefix: 'test-',
    hrefForNode: () => null,
    title: 'Test',
    query: 'claim',
  });

  assert.ok(svg.includes('data-node-id="fn:claim" class="viz-match"'));
  assert.ok(svg.includes('data-node-id="fn:swap" class="viz-dimmed"'));
  assert.ok(svg.includes('data-node-id="type:Address" class="viz-dimmed"'));
});
