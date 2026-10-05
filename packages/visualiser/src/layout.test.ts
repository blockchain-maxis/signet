import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec } from '@signet/spec';
import { buildContractGraph } from './graph.ts';
import type { ContractGraph, GraphEdge, GraphNode } from './graph.ts';
import { LAYOUT_VERSION, layoutContractGraph } from './layout.ts';
import type { PositionedDiagramModel, PositionedEdge, PositionedNode } from './layout.ts';
import { routeDiagram } from './route.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'fixtures');

/** A fixture WASM from `@signet/spec`, decoded by the real reader. */
function fixtureGraph(name: string): ContractGraph {
  return buildContractGraph(parseContractSpec(readFileSync(join(FIXTURES, `${name}.wasm`))));
}

/** A graph from names alone: functions first, then types, edges in the order given. */
function makeGraph(input: {
  functions?: string[];
  types?: string[];
  edges?: [from: string, to: string][];
}): ContractGraph {
  const nodes: GraphNode[] = [
    ...(input.functions ?? []).map(
      (name): GraphNode => ({ id: `fn:${name}`, kind: 'function', name }),
    ),
    ...(input.types ?? []).map(
      (name): GraphNode => ({ id: `type:${name}`, kind: 'type', name, typeKind: 'struct' }),
    ),
  ];
  const edges: GraphEdge[] = (input.edges ?? []).map(([from, to]) => {
    // `from` is always a full node id; `to` may be a bare type name.
    const target = to.startsWith('fn:') || to.startsWith('type:') ? to : `type:${to}`;
    return {
      id: `${from}->${target}`,
      from,
      to: target,
      kinds: ['arg'],
      roles: [{ kind: 'arg', path: target, via: 'x' }],
    };
  });
  return { nodes, edges, errors: [], events: [], build: undefined };
}

const byId = (model: PositionedDiagramModel, id: string): PositionedNode => {
  const node = model.nodes.find((n) => n.id === id);
  assert.ok(node, `node ${id} exists`);
  return node;
};

const columnsOf = (model: PositionedDiagramModel): number[] => [
  ...new Set(model.nodes.map((n) => n.x)),
];

// --- the on-chain fixtures ---------------------------------------------------

test('Identity Registry: 8 functions lay out as one column of 8 nodes', () => {
  const model = layoutContractGraph(fixtureGraph('identity-registry'));

  assert.equal(model.nodes.length, 8);
  assert.deepEqual(columnsOf(model).length, 1);
  assert.ok(model.nodes.every((n) => n.kind === 'function' && n.column === 0));
  assert.deepEqual(model.edges, []);
  assert.equal(model.layoutVersion, LAYOUT_VERSION);
  assert.ok(model.width > 0 && model.height > 0);
});

test('types_zoo: more than one column, and every edge runs left to right except those marked back', () => {
  const model = layoutContractGraph(fixtureGraph('types_zoo'));

  assert.ok(columnsOf(model).length >= 2, 'functions and the types they reach are separate columns');
  assert.ok(model.edges.length > 0);
  for (const edge of model.edges) {
    const from = byId(model, edge.from);
    const to = byId(model, edge.to);
    if (!edge.back) {
      assert.ok(to.x > from.x, `${edge.id} runs left to right`);
      assert.ok(to.column > from.column, `${edge.id} moves to a later column`);
    }
  }
});

test('types_zoo: a three-deep struct nest takes one column per level', () => {
  const model = layoutContractGraph(fixtureGraph('types_zoo'));
  const level = (name: string) => byId(model, `type:${name}`).column;

  assert.ok(level('Level1') < level('Level2'));
  assert.ok(level('Level2') < level('Level3'));
});

// --- determinism -------------------------------------------------------------

test('the same graph lays out to byte-identical JSON over 100 runs', () => {
  const graph = fixtureGraph('types_zoo');
  const first = JSON.stringify(layoutContractGraph(graph));
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.stringify(layoutContractGraph(graph)), first);
  }
});

test('layout does not mutate its input', () => {
  const graph = fixtureGraph('types_zoo');
  const before = JSON.stringify(graph);
  layoutContractGraph(graph);
  assert.equal(JSON.stringify(graph), before);
});

test('every coordinate is an integer', () => {
  const model = layoutContractGraph(fixtureGraph('types_zoo'));
  const numbers = [
    model.width,
    model.height,
    ...model.nodes.flatMap((n) => [n.x, n.y, n.width, n.height]),
    ...model.groups.flatMap((g) => [g.x, g.y, g.width, g.height]),
  ];
  assert.ok(numbers.every(Number.isInteger));
});

// --- ranking and cycles ------------------------------------------------------

test('a type reached through another type is a column to the right of it', () => {
  const model = layoutContractGraph(
    makeGraph({
      functions: ['run'],
      types: ['A', 'B'],
      edges: [
        ['fn:run', 'A'],
        ['fn:run', 'B'],
        ['type:A', 'B'],
      ],
    }),
  );

  assert.equal(byId(model, 'type:A').column, 1);
  // B is also one hop from `run`, but A points at it: sharing A's column would
  // leave that edge with nowhere to go but backwards.
  assert.equal(byId(model, 'type:B').column, 2);
  assert.ok(model.edges.every((e) => !e.back));
});

test('a recursive type is broken on its back edge and marked back', () => {
  const model = layoutContractGraph(
    makeGraph({
      functions: ['run'],
      types: ['Node', 'Leaf'],
      edges: [
        ['fn:run', 'Node'],
        ['type:Node', 'Leaf'],
        ['type:Leaf', 'Node'], // closes the cycle
      ],
    }),
  );

  const back = model.edges.filter((e) => e.back);
  assert.deepEqual(
    back.map((e) => e.id),
    ['type:Leaf->type:Node'],
  );
  assert.ok(byId(model, 'type:Node').column < byId(model, 'type:Leaf').column);
});

test('a type that refers to itself is a back edge, not an infinite loop', () => {
  const model = layoutContractGraph(
    makeGraph({
      functions: ['run'],
      types: ['Tree'],
      edges: [
        ['fn:run', 'Tree'],
        ['type:Tree', 'Tree'],
      ],
    }),
  );

  assert.deepEqual(
    model.edges.filter((e) => e.back).map((e) => e.id),
    ['type:Tree->type:Tree'],
  );
  assert.equal(byId(model, 'type:Tree').column, 1);
});

test('a type nothing points at sits in column 1', () => {
  const model = layoutContractGraph(
    makeGraph({ functions: ['run'], types: ['Used', 'Orphan'], edges: [['fn:run', 'Used']] }),
  );

  assert.equal(byId(model, 'type:Orphan').column, 1);
});

test('an edge into a function can only run backwards', () => {
  const model = layoutContractGraph(
    makeGraph({ functions: ['run'], types: ['A'], edges: [['fn:run', 'A'], ['type:A', 'fn:run']] }),
  );

  assert.deepEqual(
    model.edges.filter((e) => e.back).map((e) => e.id),
    ['type:A->fn:run'],
  );
  assert.equal(byId(model, 'fn:run').column, 0);
});

// --- ordering ----------------------------------------------------------------

test('barycentre ordering removes a crossing the spec order would draw', () => {
  // Spec order is A then B, but the first function reaches B and the second
  // reaches A: A above B would cross the two edges.
  const model = layoutContractGraph(
    makeGraph({
      functions: ['one', 'two'],
      types: ['A', 'B'],
      edges: [
        ['fn:one', 'B'],
        ['fn:two', 'A'],
      ],
    }),
  );

  assert.ok(byId(model, 'type:B').y < byId(model, 'type:A').y);
});

test('ties are broken by node id, not by graph order', () => {
  // Both types hang off the one function, so their barycentres are equal.
  const model = layoutContractGraph(
    makeGraph({
      functions: ['run'],
      types: ['Y', 'X'],
      edges: [
        ['fn:run', 'Y'],
        ['fn:run', 'X'],
      ],
    }),
  );

  assert.ok(byId(model, 'type:X').y < byId(model, 'type:Y').y);
});

// --- geometry ----------------------------------------------------------------

test('nodes in a column share an x, columns do not touch, and nothing overlaps', () => {
  const model = layoutContractGraph(fixtureGraph('types_zoo'), { columnGutter: 40 });
  const xs = columnsOf(model).sort((a, b) => a - b);

  for (let i = 1; i < xs.length; i++) {
    const left = model.nodes.filter((n) => n.x === xs[i - 1]);
    const right = xs[i]!;
    const reach = Math.max(...left.map((n) => n.x + n.width));
    assert.ok(right - reach >= 40, 'at least the gutter between columns');
  }
  for (const x of xs) {
    const column = model.nodes.filter((n) => n.x === x).sort((a, b) => a.y - b.y);
    for (let i = 1; i < column.length; i++) {
      assert.ok(column[i]!.y >= column[i - 1]!.y + column[i - 1]!.height, 'no vertical overlap');
    }
  }
  for (const n of model.nodes) {
    assert.ok(n.x >= 0 && n.y >= 0);
    assert.ok(n.x + n.width <= model.width && n.y + n.height <= model.height);
  }
});

test('node height follows the font size and width follows the label', () => {
  const small = layoutContractGraph(makeGraph({ functions: ['go', 'a_much_longer_name'] }));
  const [short, long] = small.nodes;
  assert.equal(short!.height, 28); // 14px font
  assert.ok(long!.width > short!.width);

  const big = layoutContractGraph(makeGraph({ functions: ['go'] }), { fontSizePx: 20 });
  assert.equal(big.nodes[0]!.height, 40);
});

test('a label wider than the cap is truncated, keeps its full name, and fits', () => {
  const name = 'a_function_with_an_extremely_long_name_that_cannot_possibly_fit';
  const model = layoutContractGraph(makeGraph({ functions: [name] }), { maxNodeWidth: 120 });
  const node = model.nodes[0]!;

  assert.equal(node.truncated, true);
  assert.equal(node.name, name);
  assert.ok(node.label.endsWith('…') && node.label.length < name.length);
  assert.ok(node.width <= 120);
});

test('a short label is not truncated', () => {
  const node = layoutContractGraph(makeGraph({ functions: ['claim'] })).nodes[0]!;
  assert.equal(node.truncated, false);
  assert.equal(node.label, 'claim');
});

test('an empty graph is a margin-sized canvas', () => {
  const model = layoutContractGraph(makeGraph({}), { margin: 10 });
  assert.deepEqual(model.nodes, []);
  assert.deepEqual(model.edges, []);
  assert.deepEqual(model.groups, []);
  assert.equal(model.width, 20);
  assert.equal(model.height, 20);
});

// --- groups ------------------------------------------------------------------

// Deliberately interleaved: in spec order no group's members are adjacent, so
// contiguity in the output can only come from the layout grouping them.
const GROUPED = [
  'pool_create',
  'admin_pause',
  'initialize',
  'pool_deposit',
  'get_price',
  'admin_unpause',
  'upgrade',
  'pool_withdraw',
  'admin_set_fee',
];

test('a grouped contract gets one box per group, with the members contiguous inside it', () => {
  const model = layoutContractGraph(makeGraph({ functions: GROUPED }));

  assert.ok(model.groups.length >= 2);
  const boxes = [...model.groups].sort((a, b) => a.y - b.y);
  for (let i = 1; i < boxes.length; i++) {
    assert.ok(boxes[i]!.y >= boxes[i - 1]!.y + boxes[i - 1]!.height, 'boxes do not overlap');
  }
  for (const group of model.groups) {
    const members = group.nodeIds.map((id) => byId(model, id));
    assert.ok(members.length > 0);
    for (const m of members) {
      assert.equal(m.groupId, group.id);
      assert.ok(m.x >= group.x && m.x + m.width <= group.x + group.width, 'inside horizontally');
      assert.ok(m.y >= group.y && m.y + m.height <= group.y + group.height, 'inside vertically');
    }
    // Nothing from another group sits between this group's first and last member.
    const lo = Math.min(...members.map((m) => m.y));
    const hi = Math.max(...members.map((m) => m.y));
    const strangers = model.nodes.filter((n) => n.column === 0 && n.groupId !== group.id);
    assert.ok(strangers.every((n) => n.y < lo || n.y > hi), `${group.id} is contiguous`);
  }
});

test('every function belongs to exactly one group box when the contract is grouped', () => {
  const model = layoutContractGraph(makeGraph({ functions: GROUPED }));
  const claimed = model.groups.flatMap((g) => g.nodeIds).sort();
  assert.deepEqual(claimed, GROUPED.map((n) => `fn:${n}`).sort());
});

test('a contract that does not group has no group boxes', () => {
  const model = layoutContractGraph(makeGraph({ functions: ['a', 'b', 'c'] }));
  assert.deepEqual(model.groups, []);
  assert.ok(model.nodes.every((n) => n.groupId === undefined));
});

// --- the router --------------------------------------------------------------

function assertRoutedInside(model: PositionedDiagramModel): void {
  const routed = routeDiagram<PositionedNode, PositionedEdge, PositionedDiagramModel>(model);
  assert.equal(routed.edges.length, model.edges.length);
  for (const edge of routed.edges) {
    assert.ok(edge.polyline.length >= 2);
    for (const p of edge.polyline) {
      assert.ok(p.x >= 0 && p.x <= model.width, `${edge.id} x=${p.x} inside 0..${model.width}`);
      assert.ok(p.y >= 0 && p.y <= model.height, `${edge.id} y=${p.y} inside 0..${model.height}`);
    }
  }
}

test('the router accepts the layout, and the routed edges stay on the canvas', () => {
  assertRoutedInside(layoutContractGraph(fixtureGraph('types_zoo')));
});

test('routed back edges stay on the canvas too (the room reserved above the nodes)', () => {
  assertRoutedInside(
    layoutContractGraph(
      makeGraph({
        functions: ['run'],
        types: ['Node', 'Leaf', 'Tree'],
        edges: [
          ['fn:run', 'Node'],
          ['type:Node', 'Leaf'],
          ['type:Leaf', 'Node'],
          ['fn:run', 'Tree'],
          ['type:Tree', 'Tree'],
        ],
      }),
    ),
  );
});

test('the room above the nodes holds every back-edge lane, even with a tight margin', () => {
  const model = layoutContractGraph(
    makeGraph({
      functions: ['run'],
      types: ['A', 'B', 'C', 'D'],
      edges: [
        ['fn:run', 'A'],
        ['type:A', 'B'],
        ['type:B', 'C'],
        ['type:C', 'D'],
        ['type:B', 'A'],
        ['type:C', 'A'],
        ['type:D', 'A'],
        ['type:D', 'B'],
      ],
    }),
    { margin: 8 },
  );

  assert.equal(model.edges.filter((e) => e.back).length, 4);
  assertRoutedInside(model);
});

// --- bad input ---------------------------------------------------------------

test('invalid geometry is rejected, not drawn', () => {
  const g = makeGraph({ functions: ['a'] });
  assert.throws(() => layoutContractGraph(g, { fontSizePx: 11 }), RangeError);
  assert.throws(() => layoutContractGraph(g, { fontSizePx: Number.NaN }), RangeError);
  assert.throws(() => layoutContractGraph(g, { columnGutter: -1 }), RangeError);
  assert.throws(() => layoutContractGraph(g, { maxNodeWidth: 20 }), RangeError);
  assert.throws(() => layoutContractGraph(g, { margin: 2, groupPadding: 8 }), RangeError);
});

test('a malformed graph is rejected, not drawn', () => {
  const dup = makeGraph({ functions: ['a', 'a'] });
  assert.throws(() => layoutContractGraph(dup), /duplicate node id fn:a/);

  const dangling = makeGraph({ functions: ['a'], edges: [['fn:a', 'Nope']] });
  assert.throws(() => layoutContractGraph(dangling), /node type:Nope does not exist/);
});
