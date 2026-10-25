/**
 * @file Interface diff and its badges (#580).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph } from './layout.ts';
import { loadFixture } from './load-fixture.ts';
import { renderDiagramSvg, describeMarks } from './render.ts';
import { diffBadges, diffInterfaces } from './interface-diff.ts';

const router = loadFixture('soroswap-router');

test('a function added, one removed and a type changed are told apart', () => {
  const after = {
    functions: [
      ...router.functions.filter((f) => f.name !== 'quote'),
      { name: 'swap_v2', doc: '', isConstructor: false, inputs: [], outputs: [] },
    ],
    types: router.types.map((t, i) => (i === 0 && t.kind === 'struct' ? { ...t, fields: t.fields.slice(1) } : t)),
  };
  const diff = diffInterfaces(router, after);
  assert.deepEqual(diff.added, ['fn:swap_v2']);
  assert.deepEqual(diff.removed, ['fn:quote']);
  assert.deepEqual(diff.changed, [`type:${router.types[0]!.name}`]);
  assert.deepEqual(diffInterfaces(router, router), { added: [], removed: [], changed: [] });
  // A doc comment is not an interface change.
  const documented = { ...router, functions: router.functions.map((f) => ({ ...f, doc: 'new words' })) };
  assert.deepEqual(diffInterfaces(router, documented).changed, []);
});

test('an added node carries a + badge, a changed one ~, and both say so', () => {
  const model = layoutContractGraph(buildContractGraph(router));
  const svg = renderDiagramSvg(model, {
    idPrefix: 'd-',
    hrefForNode: () => null,
    title: 't',
    diff: diffBadges({ added: ['fn:quote'], removed: [], changed: ['fn:get_factory'] }),
  });
  assert.match(svg, /data-node-id="fn:quote" data-diff="added"/);
  assert.match(svg, /data-diff-badge="added"><title>added in this build<\/title>[^]*?>\+<\/text>/);
  assert.match(svg, /data-diff-badge="changed"><title>changed in this build<\/title>[^]*?>~<\/text>/);
});

test('local sandbox marks say where they come from', () => {
  const line = describeMarks({ marks: {}, transactions: 0, firstLedger: null, lastLedger: null, sandboxRuns: 3, local: true });
  assert.equal(line, 'Read/write marks from 3 local sandbox runs on this machine, not from the chain. Not derived from the contract interface.');
  const model = layoutContractGraph(buildContractGraph(router));
  const svg = renderDiagramSvg(model, {
    idPrefix: 'l-',
    hrefForNode: () => null,
    title: 't',
    overlays: {
      mutability: {
        marks: { quote: { kind: 'writes', evidence: 'changed', writingObservations: 1, observations: 1, seededOnly: false, staleObservations: 0, unversionedObservations: 0, seededObservations: 0, example: { source: 'sandbox', ledger: 1 } } },
        transactions: 0,
        firstLedger: null,
        lastLedger: null,
        sandboxRuns: 1,
        local: true,
      },
    },
  });
  assert.match(svg, /data-node-id="fn:quote"[^>]*data-mark="write"[^>]*data-mark-source="local sandbox"/);
  assert.match(svg, /writes, observed in a local sandbox run, not from the interface/);
});
