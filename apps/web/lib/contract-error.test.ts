import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RETRY_BUTTON_CLASS, buildContractError, renderContractError } from './contract-error.ts';

type El = React.ReactElement<Record<string, unknown>>;

/** Depth-first search of an element tree for the first element of a type. */
function find(node: unknown, type: string): El | null {
  if (!React.isValidElement(node)) return null;
  const el = node as El;
  if (el.type === type) return el;
  for (const child of React.Children.toArray(el.props.children as React.ReactNode)) {
    const hit = find(child, type);
    if (hit) return hit;
  }
  return null;
}

const model = buildContractError({ handle: 'aquawolf', digest: '123456', networkName: 'Stellar Testnet' });
const render = (m = model) => renderToStaticMarkup(renderContractError(m, () => {}));

test('names the network and says nothing is shown rather than something unverified', () => {
  const html = render();
  assert.match(html, /Couldn&#x27;t reach Stellar Testnet right now/);
  assert.match(html, /role="alert"/);
  assert.match(html, /rather than something unverified/);
  assert.match(html, /ref 123456/);
  assert.match(html, /Try again/);
});

test('the retry button calls retry, once per press', () => {
  let calls = 0;
  const button = find(
    renderContractError(model, () => {
      calls += 1;
    }),
    'button',
  );
  assert.ok(button, 'a retry button is rendered');
  assert.equal(button.props.type, 'button');
  const onClick = button.props.onClick as () => void;
  onClick();
  assert.equal(calls, 1);
  onClick();
  assert.equal(calls, 2);
});

test('the retry button hover keeps text contrast (no dark-red fill)', () => {
  assert.doesNotMatch(RETRY_BUTTON_CLASS, /8b1a1a/);
  assert.match(RETRY_BUTTON_CLASS, /hover:bg-\[#2a1411\]/);
});

test('links back to the profile only for a valid handle', () => {
  assert.match(render(), /href="\/p\/aquawolf"/);
  const bad = buildContractError({ handle: '<script>x</script>', networkName: 'Stellar Testnet' });
  assert.equal(bad.handle, null);
  assert.doesNotMatch(render(bad), /Back to/);
  assert.equal(buildContractError({ networkName: 'n' }).handle, null);
});

test('no digest, no ref line; never leaks a stack or error text', () => {
  const html = render(buildContractError({ handle: 'aquawolf', networkName: 'Stellar Testnet' }));
  assert.doesNotMatch(html, /ref /);
  assert.doesNotMatch(html, /stack|Error:|node_modules|\bat \S+ \(/i);
});
