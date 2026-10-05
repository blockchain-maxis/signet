import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classifySpecError, failureCopy, type SpecFailure } from './contract-overview.ts';
import {
  SEP_41_URL,
  docsStateCopy,
  renderDocsState,
  renderSpecWarnings,
  specWarnings,
  type DocsSlot,
} from './docs-state.ts';

const ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function render(slot: DocsSlot, failure: SpecFailure, network = 'testnet'): string {
  return renderToStaticMarkup(
    renderDocsState({ slot, failure, network, address: ADDRESS }, (s) =>
      React.createElement('h2', null, s === 'functions' ? 'Functions' : 'Types'),
    ),
  );
}

/** Text of the state's heading element. */
function headingOf(html: string): string {
  const match = /<h3[^>]*data-testid="docs-state-heading"[^>]*>(.*?)<\/h3>/.exec(html);
  assert.ok(match, 'state heading present');
  return match[1]!.replace(/&#x27;/g, "'");
}

const LEAKS = [/stack/i, /\bat .*\(.*:\d+:\d+\)/, /Error:/, /node_modules/, /TypeError/, /\[object/];

function assertClean(html: string): void {
  for (const leak of LEAKS) assert.doesNotMatch(html, leak);
}

const CASES: readonly {
  name: string;
  failure: SpecFailure;
  heading: string;
  includes: readonly string[];
}[] = [
  {
    name: 'contract_not_found',
    failure: { kind: 'contract_not_found', network: 'testnet' },
    heading: 'Not found on testnet',
    includes: [ADDRESS, 'Check that the network is the one it was deployed to'],
  },
  {
    name: 'no_interface (no section)',
    failure: { kind: 'no_interface' },
    heading: 'This contract publishes no interface',
    includes: ['no functions or types to list'],
  },
  {
    name: 'no_interface (stellar asset contract)',
    failure: { kind: 'no_interface', reason: 'stellar_asset_contract' },
    heading: 'This is a Stellar Asset Contract',
    includes: ['Its interface is defined by the protocol, not by deployed WASM.', SEP_41_URL],
  },
  {
    name: 'interface_unreadable',
    failure: { kind: 'interface_unreadable', sdkVersion: '16.1.0' },
    heading: 'Interface could not be read',
    includes: ['@stellar/stellar-sdk 16.1.0'],
  },
  {
    name: 'unavailable (rpc_unavailable)',
    failure: { kind: 'unavailable' },
    heading: "Couldn't reach testnet RPC. Try again shortly.",
    includes: [],
  },
  {
    name: 'wrong_network',
    failure: { kind: 'wrong_network', network: 'mainnet', expectedNetwork: 'testnet' },
    heading: 'This contract is on mainnet',
    includes: ['This site reads testnet'],
  },
];

for (const c of CASES) {
  for (const slot of ['functions', 'types'] as const) {
    test(`docs state: ${c.name} on the ${slot} tab`, () => {
      const html = render(slot, c.failure);
      assert.equal(headingOf(html), c.heading);
      for (const text of c.includes) assert.ok(html.includes(text), `contains ${text}`);
      assert.ok(html.includes(`data-testid="slot-${slot}"`));
      assert.ok(html.includes(`data-kind="${c.failure.kind}"`));
      assertClean(html);
    });
  }
}

test('a Stellar Asset Contract renders no function list and links to SEP-41 only', () => {
  const html = render('functions', { kind: 'no_interface', reason: 'stellar_asset_contract' });
  assert.doesNotMatch(html, /<ul|<li|fn-/);
  assert.match(html, /href="https:\/\/github\.com\/stellar\/stellar-protocol\/[^"]*sep-0041\.md"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('only the not-found state prints the address', () => {
  for (const c of CASES) {
    const html = render('functions', c.failure);
    assert.equal(
      html.includes(`>${ADDRESS}<`),
      c.failure.kind === 'contract_not_found',
      c.name,
    );
  }
});

test('the RPC heading names the contract’s network', () => {
  assert.equal(
    docsStateCopy({ kind: 'unavailable' }, 'mainnet').heading,
    "Couldn't reach mainnet RPC. Try again shortly.",
  );
});

test('the docs states reuse the Overview copy where they do not differ', () => {
  for (const failure of [
    { kind: 'contract_not_found', network: 'testnet' },
    { kind: 'interface_unreadable', sdkVersion: '16.1.0' },
    { kind: 'wrong_network', network: 'mainnet', expectedNetwork: 'testnet' },
    { kind: 'no_interface' },
  ] satisfies SpecFailure[]) {
    assert.equal(docsStateCopy(failure, 'testnet').heading, failureCopy(failure).title);
  }
});

test('a state never renders a raw error, whatever the thrown object carried', () => {
  const thrown = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8000'), {
    kind: 'rpc_unavailable',
    stack: 'Error: boom\n    at fetch (/srv/app/node_modules/x.js:1:1)',
  });
  const html = render('functions', classifySpecError(thrown, 'testnet'));
  assert.equal(headingOf(html), "Couldn't reach testnet RPC. Try again shortly.");
  assert.doesNotMatch(html, /ECONNREFUSED|10\.0\.0\.1|boom|node_modules/);
});

test('classifySpecError keeps the Stellar Asset Contract reason and nothing else', () => {
  assert.deepEqual(
    classifySpecError({ kind: 'no_interface', reason: 'stellar_asset_contract' }, 'testnet'),
    { kind: 'no_interface', reason: 'stellar_asset_contract' },
  );
  assert.deepEqual(classifySpecError({ kind: 'no_interface', reason: 'empty_section' }, 'testnet'), {
    kind: 'no_interface',
  });
});

test('warnings are trimmed, de-duplicated and blank ones dropped', () => {
  assert.deepEqual(specWarnings({ warnings: [' a ', 'a', '', '   ', 'b'] }), ['a', 'b']);
  assert.deepEqual(specWarnings({}), []);
});

test('no warnings renders nothing; some render as a muted list', () => {
  assert.equal(renderSpecWarnings([]), null);
  const html = renderToStaticMarkup(renderSpecWarnings(['unknown spec arm skipped'])!);
  assert.match(html, /<ul[^>]*data-testid="spec-warnings"/);
  assert.match(html, /<li>unknown spec arm skipped<\/li>/);
  assert.match(html, /text-\[#8a8779\]/);
});
