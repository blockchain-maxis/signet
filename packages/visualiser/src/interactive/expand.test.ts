/**
 * @file Tests for expanding groups in place (#502), with a DOM double.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enhanceExpand } from './expand.ts';

class FakeElement {
  focused = false;
  innerHTMLValue = '';
  readonly attrs = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  private listeners: ((e: unknown) => void)[] = [];
  constructor(attrs: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  append(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  closest(selector: string): FakeElement | null {
    const isToggle = (el: FakeElement) =>
      selector === 'a[data-group-toggle]' && el.attrs.has('data-group-toggle') && el.attrs.has('href');
    if (isToggle(this)) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
  contains(other: FakeElement) {
    for (let at: FakeElement | null = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  focus() {
    this.focused = true;
  }
  set innerHTML(html: string) {
    this.innerHTMLValue = html;
    // The fragment brings the toggled group's link back.
    this.children = [];
    const match = /data-group-toggle="([^"]+)"/.exec(html);
    if (match) this.append(new FakeElement({ 'data-group-toggle': match[1]!, href: '?' }));
  }
  get innerHTML() {
    return this.innerHTMLValue;
  }
  querySelector(selector: string): FakeElement | null {
    const group = /data-group-toggle="([^"]+)"/.exec(selector)?.[1];
    const walk = (el: FakeElement): FakeElement | null => {
      for (const c of el.children) {
        if (c.attrs.get('data-group-toggle') === group) return c;
        const found = walk(c);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  addEventListener(_: string, fn: (e: unknown) => void) {
    this.listeners.push(fn);
  }
  removeEventListener(_: string, fn: (e: unknown) => void) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  click(target: FakeElement, extra: Record<string, unknown> = {}) {
    let prevented = false;
    const event = { target, button: 0, defaultPrevented: false, preventDefault: () => (prevented = true), ...extra };
    for (const l of this.listeners) l(event);
    return prevented;
  }
}

const PAGE = 'https://signet.example/p/a/contract/C/diagram';

function setup(answer: { ok: boolean; html: string } | Error) {
  const region = new FakeElement();
  const node = region.append(new FakeElement({ 'data-group-toggle': 'pool', href: '?expand=pool' }));
  const fetched: string[] = [];
  const replaced: string[] = [];
  const navigated: string[] = [];
  const controller = enhanceExpand({
    region: region as unknown as HTMLElement,
    fragmentUrl: (url) => `${url.pathname}/fragment${url.search}`,
    fetch: async (url) => {
      fetched.push(url);
      if (answer instanceof Error) throw answer;
      return { ok: answer.ok, text: async () => answer.html };
    },
    replaceUrl: (url) => replaced.push(url),
    navigate: (url) => navigated.push(url),
    baseUrl: () => PAGE,
  });
  return { region, node, fetched, replaced, navigated, controller };
}

test('a group link swaps in the server fragment, keeps focus on the group, and updates the URL', async () => {
  const s = setup({ ok: true, html: '<a data-group-toggle="pool" href="?">Collapse pool</a><svg></svg>' });
  assert.equal(s.region.click(s.node), true, 'the navigation is intercepted');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(s.fetched, ['/p/a/contract/C/diagram/fragment?expand=pool']);
  assert.deepEqual(s.replaced, ['/p/a/contract/C/diagram?expand=pool']);
  assert.match(s.region.innerHTML, /Collapse pool/);
  assert.equal(s.region.children[0]!.focused, true);
  assert.deepEqual(s.navigated, []);
  s.controller.destroy();
});

test('a failed fragment falls back to following the link', async () => {
  for (const answer of [{ ok: false, html: '' }, new Error('offline')]) {
    const s = setup(answer);
    s.region.click(s.node);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(s.navigated, [`${PAGE}?expand=pool`]);
    assert.deepEqual(s.replaced, []);
  }
});

test('modified clicks and other links are left to the browser', () => {
  const s = setup({ ok: true, html: '' });
  assert.equal(s.region.click(s.node, { metaKey: true }), false);
  assert.equal(s.region.click(s.node, { button: 1 }), false);
  const other = s.region.append(new FakeElement({ href: '/elsewhere' }));
  assert.equal(s.region.click(other), false);
  assert.deepEqual(s.fetched, []);
});
