/**
 * @file Tests for the server-first expand/collapse enhancer (#502).
 *
 * The enhancer's DOM surface is deliberately small — one delegated listener,
 * one attribute selector and a replace — so a hand-rolled double is enough to
 * prove the click handling, fragment swap, focus restoration and URL update.
 * The real browser path (middle-click, keyboard activation, focus rings) is
 * covered by the Playwright specs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_CONTROL_SELECTOR, enhanceExpand, groupToggleSelector } from './expand.ts';

interface FakeElement {
  attributes: Map<string, string>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

class FakeNode implements FakeElement {
  readonly attributes = new Map<string, string>();
  textContent = '';
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeContainer extends FakeNode {
  readonly ownerDocument: {
    defaultView: { history: { replaceState: (a: unknown, b: string, url: string) => void } };
  };
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private focusTarget: FakeNode | null = null;
  status: FakeNode | null = null;
  svg: FakeNode | null = null;
  toggleSelectorSeen = '';

  constructor() {
    super();
    this.ownerDocument = { defaultView: { history: { replaceState: () => {} } } };
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler);
  }
  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(handler);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  querySelector(selector: string): FakeNode | null {
    if (selector === 'svg') return this.svg;
    if (selector === '[data-diagram-status]') return this.status;
    if (selector.startsWith('[data-group-toggle=')) {
      this.toggleSelectorSeen = selector;
      return this.focusTarget;
    }
    return null;
  }

  setFocusTarget(target: FakeNode | null): void {
    this.focusTarget = target;
  }
}

function link(attributes: Record<string, string>): FakeNode {
  const element = new FakeNode();
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function click(element: FakeNode, overrides: Partial<Record<string, unknown>> = {}) {
  let prevented = false;
  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: {
      closest: (selector: string) => (selector === GROUP_CONTROL_SELECTOR ? element : null),
    },
    preventDefault: () => {
      prevented = true;
    },
    ...overrides,
  };
  return { event, wasPrevented: () => prevented };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('clicking an expand link fetches the fragment, swaps it, focuses the group and updates the URL', async () => {
  const container = new FakeContainer();
  const current = new FakeNode();
  const next = new FakeNode();
  const focusTarget = new FakeNode();
  const status = new FakeNode();
  container.svg = current;
  container.status = status;
  container.setFocusTarget(focusTarget);

  let fetched = '';
  let replaced: [unknown, unknown] | null = null;
  let focused: unknown = null;
  let replacedUrl = '';
  const { event, wasPrevented } = click(
    link({
      href: '/p/alice/contract/C1/diagram?expand=pool',
      'data-expand-group': 'pool',
      'data-group-toggle': 'pool',
    }),
  );

  const teardown = enhanceExpand(container as unknown as Element, {
    fetchText: async (url) => {
      fetched = url;
      return '<svg/>';
    },
    parseSvg: () => next as unknown as SVGSVGElement,
    replaceSvg: (a, b) => {
      replaced = [a, b];
    },
    focus: (element) => {
      focused = element;
    },
    history: {
      replaceState: (_state, _title, url) => {
        replacedUrl = typeof url === 'string' ? url : String(url);
      },
    },
  });

  container.fire('click', event);
  await flush();

  assert.equal(wasPrevented(), true);
  assert.equal(fetched, '/p/alice/contract/C1/diagram?expand=pool');
  assert.deepEqual(replaced, [current, next]);
  assert.equal(focused, focusTarget);
  assert.equal(replacedUrl, '/p/alice/contract/C1/diagram?expand=pool');
  assert.equal(container.getAttribute('aria-busy'), null);
  assert.equal(status.textContent, 'Expanded pool.');
  assert.match(container.toggleSelectorSeen, /pool/);
  teardown();
});

test('clicking a collapse link focuses the group control and announces the state', async () => {
  const container = new FakeContainer();
  container.svg = new FakeNode();
  const status = new FakeNode();
  container.status = status;
  const focusTarget = new FakeNode();
  container.setFocusTarget(focusTarget);

  let focused: unknown = null;
  const { event } = click(
    link({
      href: '/p/alice/contract/C1/diagram',
      'data-collapse-group': 'pool',
      'data-group-toggle': 'pool',
    }),
  );
  const teardown = enhanceExpand(container as unknown as Element, {
    fetchText: async () => '<svg/>',
    parseSvg: () => new FakeNode() as unknown as SVGSVGElement,
    replaceSvg: () => {},
    focus: (element) => {
      focused = element;
    },
    history: { replaceState: () => {} },
  });

  container.fire('click', event);
  await flush();

  assert.equal(focused, focusTarget);
  assert.match(status.textContent, /Collapsed pool/);
  teardown();
});

test('modified clicks are left to the browser', () => {
  const container = new FakeContainer();
  let fetched = false;
  const teardown = enhanceExpand(container as unknown as Element, {
    fetchText: async () => {
      fetched = true;
      return '<svg/>';
    },
  });
  const { event, wasPrevented } = click(
    link({ href: '/d?expand=pool', 'data-expand-group': 'pool' }),
    { metaKey: true },
  );
  container.fire('click', event);
  assert.equal(wasPrevented(), false);
  assert.equal(fetched, false);
  teardown();
});

test('a failed fragment fetch falls back to a full navigation', async () => {
  const container = new FakeContainer();
  let navigated = '';
  const teardown = enhanceExpand(container as unknown as Element, {
    fetchText: async () => {
      throw new Error('offline');
    },
    navigate: (url) => {
      navigated = url;
    },
  });
  const { event } = click(link({ href: '/d?expand=pool', 'data-expand-group': 'pool' }));
  container.fire('click', event);
  await flush();
  assert.equal(navigated, '/d?expand=pool');
  assert.equal(container.getAttribute('aria-busy'), null);
  teardown();
});

test('enhancing twice is a no-op and teardown removes the listener', () => {
  const container = new FakeContainer();
  const first = enhanceExpand(container as unknown as Element);
  assert.equal(container.getAttribute('data-expand-enhanced'), 'true');
  assert.equal(container.listenerCount('click'), 1);
  const second = enhanceExpand(container as unknown as Element);
  second();
  assert.equal(container.listenerCount('click'), 1, 'second teardown must not undo the first');
  first();
  assert.equal(container.listenerCount('click'), 0);
  assert.equal(container.getAttribute('data-expand-enhanced'), null);
});

test('the group selector escapes quotes in a name', () => {
  assert.equal(groupToggleSelector('pool'), '[data-group-toggle="pool"]');
  assert.equal(groupToggleSelector('a"b'), '[data-group-toggle="a\\"b"]');
});
