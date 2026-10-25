/**
 * @file The call graph overlay's layout (#543): the callee column, its order
 * and collapse, the anchor, and the edges' weights.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractGraph } from './graph.ts';
import {
  CALL_ANCHOR_ID,
  CALLEES_MORE_ID,
  MAX_CALLEES,
  calleeNodeId,
  layoutContractGraph,
  type PositionedDiagramModel,
} from './layout.ts';
import { loadFixture } from './load-fixture.ts';
import { renderDiagramSvg } from './render.ts';
import { buildCallGraph, type CallGraphRow } from './observe/call-graph.ts';

const SELF = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const callee = (n: number) => `C${String(n).padStart(2, '0')}${'A'.repeat(53)}`;

/** `counts[i]` transactions from `fn` to callee i. */
function rows(counts: number[], fn: string | null = 'claim'): CallGraphRow[] {
  const out: CallGraphRow[] = [];
  let ledger = 1;
  counts.forEach((n, i) => {
    for (let k = 0; k < n; k++) {
      out.push({
        ledger: ledger++,
        function: fn,
        callEdges: [{ from: SELF, to: callee(i), evidence: 'auth-tree' }],
      });
    }
  });
  return out;
}

const graph = buildContractGraph(loadFixture('blend-pool-v1'));

function laidOut(callRows: CallGraphRow[], expand = false): PositionedDiagramModel {
  const fn = graph.nodes.find((n) => n.kind === 'function')!.name;
  const fixed = callRows.map((r) => ({ ...r, function: r.function === 'claim' ? fn : r.function }));
  return layoutContractGraph(
    graph,
    {},
    { calls: { overlay: buildCallGraph(SELF, fixed), expand } },
  );
}

test('callees are the right-most column, heaviest first, ties by address', () => {
  const model = laidOut(rows([1, 5, 3, 3]));
  const callees = model.nodes.filter((n) => n.kind === 'callee');
  assert.deepEqual(
    [...callees].sort((a, b) => a.y - b.y).map((n) => n.address),
    [callee(1), callee(2), callee(3), callee(0)],
  );
  const rightmostOther = Math.max(
    ...model.nodes.filter((n) => n.kind !== 'callee').map((n) => n.x + n.width),
  );
  for (const c of callees) assert.ok(c.x > rightmostOther, 'right of everything else');
  assert.equal(new Set(callees.map((c) => c.x)).size, 1, 'one column');
  assert.equal(model.calls?.shown, 4);
});

test(`past ${MAX_CALLEES} callees the rest collapse into one node, unless expanded`, () => {
  const counts = Array.from({ length: MAX_CALLEES + 3 }, (_, i) => 20 - i);
  const collapsed = laidOut(rows(counts));
  const more = collapsed.nodes.find((n) => n.id === CALLEES_MORE_ID)!;
  assert.equal(more.label, '+3 other contracts');
  assert.deepEqual(more.hiddenAddresses, [callee(12), callee(13), callee(14)]);
  assert.equal(collapsed.nodes.filter((n) => n.kind === 'callee').length, MAX_CALLEES);
  assert.ok(collapsed.edges.some((e) => e.to === CALLEES_MORE_ID && e.call!.count === 8 + 7 + 6));
  assert.deepEqual([collapsed.calls!.shown, collapsed.calls!.hidden], [MAX_CALLEES, 3]);

  const expanded = laidOut(rows(counts), true);
  assert.equal(expanded.nodes.filter((n) => n.kind === 'callee').length, MAX_CALLEES + 3);
  assert.ok(!expanded.nodes.some((n) => n.id === CALLEES_MORE_ID));
});

test('a call from an unknown function starts from an anchor at the top of the spine', () => {
  const model = laidOut([...rows([2]), ...rows([0, 1], null), ...rows([0, 1], 'not_in_the_spec')]);
  const anchor = model.nodes.find((n) => n.id === CALL_ANCHOR_ID)!;
  assert.equal(anchor.label, 'contract (function unknown)');
  const spine = model.nodes.filter((n) => n.column === 0 && n.id !== CALL_ANCHOR_ID);
  assert.ok(
    spine.every((n) => n.y > anchor.y),
    'above every function',
  );
  assert.equal(anchor.x, spine[0]!.x);
  const fromAnchor = model.edges.filter((e) => e.from === CALL_ANCHOR_ID);
  assert.deepEqual(
    fromAnchor.map((e) => [e.to, e.call!.count]),
    [[calleeNodeId(callee(1)), 2]],
  );
});

test('stroke weight steps by the tercile of the call counts', () => {
  const model = laidOut(rows([1, 1, 2, 2, 9, 9]));
  const weight = (i: number) =>
    model.edges.find((e) => e.to === calleeNodeId(callee(i)))!.call!.weight;
  assert.deepEqual([0, 2, 4].map(weight), [1, 2, 3]);
  const even = laidOut(rows([4, 4]));
  assert.ok(
    even.edges.filter((e) => e.call).every((e) => e.call!.weight === 1),
    'all equal, all thin',
  );
});

test('a callee is tall enough for each edge into it to have its own band', () => {
  const fns = graph.nodes
    .filter((n) => n.kind === 'function')
    .slice(0, 4)
    .map((n) => n.name);
  const overlay = buildCallGraph(
    SELF,
    fns.map((fn, i) => ({
      ledger: i,
      function: fn,
      callEdges: [{ from: SELF, to: callee(0), evidence: 'event' as const }],
    })),
  );
  const model = layoutContractGraph(graph, {}, { calls: { overlay } });
  assert.equal(model.nodes.find((n) => n.id === calleeNodeId(callee(0)))!.height, 5 * 16);
});

test('no calls, no callee column and no call footer', () => {
  const plain = layoutContractGraph(graph);
  const empty = layoutContractGraph(
    graph,
    {},
    { calls: { overlay: buildCallGraph(SELF, rows([0])) } },
  );
  assert.deepEqual(empty, plain);
  const svg = renderDiagramSvg(empty, { idPrefix: 'x-', hrefForNode: () => null, title: 't' });
  assert.ok(!svg.includes('diagram-node--callee'));
  assert.ok(!svg.includes('diagram-call-footer'));
});
