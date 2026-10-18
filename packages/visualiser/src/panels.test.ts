/**
 * @file Tests for error surface, declared events and build provenance panels (#496).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractGraph } from './graph.ts';
import { loadFixture } from './load-fixture.ts';
import { diagramPanels, renderPanelsHtml } from './panels.ts';

test('diagramPanels and renderPanelsHtml for identity-registry fixture', () => {
  const spec = loadFixture('identity-registry');
  const graph = buildContractGraph(spec);
  const panels = diagramPanels(graph);

  // Errors extracted
  assert.equal(panels.errors.length, 7);
  const handleTaken = panels.errors.find((e) => e.name === 'HandleTaken');
  assert.ok(handleTaken);
  assert.equal(handleTaken.code, 3);

  const notOwner = panels.errors.find((e) => e.name === 'NotOwner');
  assert.ok(notOwner);
  assert.equal(notOwner.code, 5);

  const walletBound = panels.errors.find((e) => e.name === 'WalletAlreadyBound');
  assert.ok(walletBound);
  assert.equal(walletBound.code, 7);

  // Events empty on registry
  assert.equal(panels.events.length, 0);

  // Render HTML
  const html = renderPanelsHtml(panels);

  // Acceptance criteria:
  // 1. Lists error enum by name and code (HandleTaken, NotOwner, WalletAlreadyBound)
  assert.ok(html.includes('HandleTaken'), 'html includes HandleTaken');
  assert.ok(html.includes('#3'), 'html includes #3');
  assert.ok(html.includes('NotOwner'), 'html includes NotOwner');
  assert.ok(html.includes('#5'), 'html includes #5');
  assert.ok(html.includes('WalletAlreadyBound'), 'html includes WalletAlreadyBound');
  assert.ok(html.includes('#7'), 'html includes #7');

  // 2. Shows events as empty with exact text "No events declared in the interface"
  assert.ok(
    html.includes('No events declared in the interface'),
    'html includes "No events declared in the interface"',
  );

  // 3. States plainly that spec does not map errors to functions
  assert.ok(
    html.includes('Returned by: not declared in the contract interface'),
    'html explains that error mapping is contract-level',
  );

  // 4. No hex colours
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(html.replace(/#\d+/g, '')), false);
});

test('diagramPanels handles declared events and build provenance', () => {
  const dummyGraph = {
    errors: [{ enumName: 'MyError', name: 'CustomErr', value: 101, doc: 'An error happened' }],
    events: [
      {
        name: 'TransferEvent',
        doc: 'Emitted on transfer',
        prefixTopics: ['transfer'],
        params: [
          { name: 'from', type: 'address' as const, location: 'topic' as const },
          { name: 'amount', type: 'i128' as const, location: 'data' as const },
        ],
        dataFormat: 'single_value' as const,
      },
    ],
    build: {
      sdkVersion: '21.0.0',
      rustVersion: '1.80.0',
      entries: {},
    },
  };

  const panels = diagramPanels(dummyGraph);
  assert.equal(panels.errors.length, 1);
  assert.equal(panels.errors[0]!.name, 'CustomErr');
  assert.equal(panels.errors[0]!.code, 101);

  assert.equal(panels.events.length, 1);
  assert.equal(panels.events[0]!.name, 'TransferEvent');
  assert.deepEqual(panels.events[0]!.topics, ['transfer', 'from']);
  assert.equal(panels.events[0]!.dataType, 'amount: i128');

  assert.equal(panels.build?.sdkVersion, '21.0.0');
  assert.equal(panels.build?.rustVersion, '1.80.0');

  const html = renderPanelsHtml(panels);
  assert.ok(html.includes('CustomErr'));
  assert.ok(html.includes('#101'));
  assert.ok(html.includes('TransferEvent'));
  assert.ok(html.includes('transfer · from'));
  assert.ok(html.includes('amount: i128'));
  assert.ok(html.includes('21.0.0'));
  assert.ok(html.includes('1.80.0'));
});

test('renderPanelsHtml escapes special characters in strings', () => {
  const dummy = {
    errors: [{ enumName: 'Bad<Enum>', name: 'Err&Special', value: 99, doc: 'Uses <b>bold</b> & "quotes"' }],
    events: [],
  };

  const html = renderPanelsHtml(diagramPanels(dummy));
  assert.ok(html.includes('Err&amp;Special'));
  assert.ok(html.includes('Bad&lt;Enum&gt;'));
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;'));
  assert.equal(html.includes('<b>bold</b>'), false);
});
