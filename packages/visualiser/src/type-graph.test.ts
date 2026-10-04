/**
 * A mid-size fixture spec for the depth policy (#490): the shape design §3
 * calls the hard case — a router with ~10 functions and a type graph four
 * levels deep, with a shared subtree (`Amount`, `Color`), a recursive type
 * (`PoolPair.next`), a reference the spec never defines (`Ghost`), and a
 * `Result` over an error enum (`ZooError`).
 *
 * Written against the flattened views rather than WASM on purpose: the policy
 * consumes `functions`/`types`/`errors` only, so the fixture stays readable and
 * the assertions say what they mean. The chain that sets the depth budget is
 * `swap(route: Route)` → `Route.steps: Vec<RouteStep>` →
 * `RouteStep.pool: PoolConfig` → `PoolConfig.limits: Limits`.
 */
import type { ContractSpec, SpecFunction, SpecType, TypeRef } from '@signet/spec';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TypeGraph, TypeGraphNode } from './type-graph.ts';
import {
  DEFAULT_TYPE_DEPTH,
  buildTypeGraph,
  functionNodeId,
  typeAnchor,
  typeNodeId,
} from './type-graph.ts';
import { buildTypeGraph as buildFromEntry } from './index.ts';

const TYPES: readonly SpecType[] = [
  {
    kind: 'struct',
    name: 'Route',
    fields: [
      { name: 'id', type: 'u32' },
      { name: 'steps', type: { type: 'vec', element: { type: 'named', name: 'RouteStep' } } },
      { name: 'cache', type: { type: 'option', value: { type: 'named', name: 'CacheKey' } } },
    ],
  },
  {
    kind: 'struct',
    name: 'RouteStep',
    fields: [
      { name: 'pool', type: { type: 'named', name: 'PoolConfig' } },
      { name: 'delta', type: { type: 'named', name: 'Amount' } },
      { name: 'tag', type: { type: 'named', name: 'Color' } },
    ],
  },
  {
    kind: 'struct',
    name: 'PoolConfig',
    fields: [
      { name: 'pair', type: { type: 'named', name: 'PoolPair' } },
      { name: 'fee', type: { type: 'named', name: 'FeeSchedule' } },
      { name: 'limits', type: { type: 'named', name: 'Limits' } },
    ],
  },
  {
    kind: 'struct',
    name: 'Limits',
    fields: [
      { name: 'per', type: { type: 'vec', element: { type: 'named', name: 'Amount' } } },
    ],
  },
  { kind: 'struct', name: 'Amount', fields: [{ name: 'value', type: 'i128' }] },
  { kind: 'struct', name: 'CacheKey', fields: [{ name: 'owner', type: 'address' }] },
  {
    kind: 'struct',
    name: 'PoolPair',
    fields: [
      { name: 'next', type: { type: 'option', value: { type: 'named', name: 'PoolPair' } } },
      { name: 'ghost', type: { type: 'named', name: 'Ghost' } },
    ],
  },
  {
    kind: 'union',
    name: 'FeeSchedule',
    cases: [
      {
        name: 'Tiered',
        fields: [
          {
            name: '0',
            type: { type: 'vec', element: { type: 'named', name: 'FeeTier' } },
          },
        ],
      },
      { name: 'Flat', fields: [{ name: '1', type: 'u32' }] },
    ],
  },
  { kind: 'struct', name: 'FeeTier', fields: [{ name: 'min', type: 'i128' }] },
  {
    kind: 'enum',
    name: 'Color',
    variants: [
      { name: 'Red', value: 1 },
      { name: 'Green', value: 2 },
    ],
  },
];

const FUNCTIONS: readonly SpecFunction[] = [
  {
    name: 'swap',
    doc: 'Execute a route.',
    isConstructor: false,
    inputs: [{ name: 'route', type: { type: 'named', name: 'Route' } }],
    outputs: [{ type: 'option', value: { type: 'named', name: 'Route' } }],
  },
  {
    name: 'batch',
    doc: 'Execute routes.',
    isConstructor: false,
    inputs: [
      {
        name: 'routes',
        type: { type: 'vec', element: { type: 'vec', element: { type: 'named', name: 'Route' } } },
      },
    ],
    outputs: ['u32'],
  },
  {
    name: 'quote',
    doc: 'Price a route.',
    isConstructor: false,
    inputs: [
      { name: 'amounts', type: { type: 'vec', element: { type: 'named', name: 'Amount' } } },
      { name: 'fee', type: { type: 'named', name: 'FeeSchedule' } },
    ],
    outputs: [{ type: 'named', name: 'Amount' }],
  },
  {
    name: 'pairs',
    doc: 'Walk the pool graph.',
    isConstructor: false,
    inputs: [{ name: 'pair', type: { type: 'named', name: 'PoolPair' } }],
    outputs: [{ type: 'named', name: 'PoolPair' }],
  },
  {
    name: 'palette',
    doc: 'List colours.',
    isConstructor: false,
    inputs: [{ name: 'tag', type: { type: 'named', name: 'Color' } }],
    outputs: [{ type: 'named', name: 'Color' }],
  },
  {
    name: 'admin_set_cache',
    doc: 'Store a cached route.',
    isConstructor: false,
    inputs: [
      { name: 'key', type: { type: 'named', name: 'CacheKey' } },
      { name: 'value', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'phantom',
    doc: 'Name a type that is never defined.',
    isConstructor: false,
    inputs: [{ name: 'x', type: { type: 'named', name: 'Ghost' } }],
    outputs: [{ type: 'named', name: 'Ghost' }],
  },
  {
    name: 'fallible',
    doc: 'Return a Result over the error enum.',
    isConstructor: false,
    inputs: [
      {
        name: 'v',
        type: { type: 'result', ok: 'u32', error: { type: 'named', name: 'ZooError' } },
      },
    ],
    outputs: [{ type: 'result', ok: 'u32', error: { type: 'named', name: 'ZooError' } }],
  },
  { name: 'ints', doc: '', isConstructor: false, inputs: [{ name: 'a', type: 'u32' }], outputs: ['u32'] },
  {
    name: 'who',
    doc: '',
    isConstructor: false,
    inputs: [{ name: 'who', type: 'address' }],
    outputs: ['address'],
  },
];

const MID_SIZE: Pick<ContractSpec, 'functions' | 'types' | 'errors'> = {
  functions: FUNCTIONS,
  types: TYPES,
  errors: [{ enumName: 'ZooError', name: 'OutOfRange', value: 1, doc: 'Out of range.' }],
};

/** Names of the nodes a graph draws, in discovery order. */
function names(graph: TypeGraph): string[] {
  return graph.nodes.map((node) => node.name);
}

function nodeOf(graph: TypeGraph, name: string): TypeGraphNode {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `${name} is a node`);
  return node;
}

/** Every type name reachable from the graph's stubs, however deep. */
function behindStubs(graph: TypeGraph): Set<string> {
  const byName = new Map(TYPES.map((type) => [type.name, type]));
  const out = new Set<string>();
  const queue = graph.nodes.filter((node) => node.kind === 'stub').map((node) => node.name);
  for (let i = 0; i < queue.length; i++) {
    for (const child of membersOf(byName.get(queue[i]!))) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** Named types a definition mentions, wrappers ignored. */
function membersOf(type: SpecType | undefined): string[] {
  if (type === undefined) return [];
  if (type.kind === 'struct') return type.fields.flatMap((field) => namedIn(field.type));
  if (type.kind === 'union') {
    return type.cases.flatMap((unionCase) => unionCase.fields.flatMap((field) => namedIn(field.type)));
  }
  return [];
}

/** Named types under a `TypeRef`: the same rule the module applies. */
function namedIn(ref: TypeRef): string[] {
  if (typeof ref === 'string') return [];
  switch (ref.type) {
    case 'named':
      return [ref.name];
    case 'option':
      return namedIn(ref.value);
    case 'result':
      return [...namedIn(ref.ok), ...namedIn(ref.error)];
    case 'vec':
      return namedIn(ref.element);
    case 'map':
      return [...namedIn(ref.key), ...namedIn(ref.value)];
    case 'tuple':
      return ref.elements.flatMap((element) => namedIn(element));
    default:
      return [];
  }
}

test('DEFAULT_TYPE_DEPTH is the one level design §3 asks for', () => {
  assert.equal(DEFAULT_TYPE_DEPTH, 1);
  assert.deepEqual(names(buildTypeGraph(MID_SIZE)), names(buildTypeGraph(MID_SIZE, { typeDepth: 1 })));
});

test('typeDepth: 1 draws fewer nodes than typeDepth: Infinity', () => {
  const shallow = buildTypeGraph(MID_SIZE, { typeDepth: 1 });
  const deep = buildTypeGraph(MID_SIZE, { typeDepth: Infinity });
  assert.ok(shallow.nodes.length < deep.nodes.length);
  assert.deepEqual(names(deep).sort(), [
    'Amount',
    'CacheKey',
    'Color',
    'FeeSchedule',
    'FeeTier',
    'Limits',
    'PoolConfig',
    'PoolPair',
    'Route',
    'RouteStep',
  ]);
});

test('every type the budget hides is reachable as a stub', () => {
  for (const typeDepth of [0, 1, 2]) {
    const graph = buildTypeGraph(MID_SIZE, { typeDepth });
    const drawn = new Set(names(graph));
    const reachable = new Set(names(buildTypeGraph(MID_SIZE, { typeDepth: Infinity })));
    const hidden = behindStubs(graph);
    for (const name of reachable) {
      if (drawn.has(name)) continue;
      assert.ok(hidden.has(name), `typeDepth ${typeDepth}: ${name} is behind a stub`);
    }
  }
});

test('a type is one node, at its shallowest depth', () => {
  const graph = buildTypeGraph(MID_SIZE, { typeDepth: Infinity });
  assert.equal(nodeOf(graph, 'Amount').depth, 1); // direct argument of quote
  assert.equal(nodeOf(graph, 'RouteStep').depth, 2);
  assert.equal(nodeOf(graph, 'PoolConfig').depth, 3);
  assert.equal(nodeOf(graph, 'Limits').depth, 4);
  assert.equal(new Set(names(graph)).size, graph.nodes.length);
});

test('wrappers do not spend depth: Vec<Vec<Route>> is still a direct type', () => {
  const graph = buildTypeGraph(MID_SIZE);
  assert.equal(nodeOf(graph, 'Route').depth, 1);
  assert.equal(nodeOf(graph, 'RouteStep').kind, 'stub');
});

test('a stub keeps no outgoing edges and counts the ones it hides', () => {
  const graph = buildTypeGraph(MID_SIZE, { typeDepth: 1 });
  const step = nodeOf(graph, 'RouteStep');
  assert.equal(step.kind, 'stub');
  assert.equal(step.hidden, 3); // pool, delta, tag
  assert.equal(step.label, 'RouteStep +3');
  assert.equal(step.anchor, typeAnchor('RouteStep'));
  assert.equal(graph.edges.filter((edge) => edge.from === step.id).length, 0);
  assert.equal(nodeOf(graph, 'FeeTier').label, 'FeeTier'); // a leaf stub, nothing hidden
  assert.equal(nodeOf(graph, 'Route').kind, 'inline');
  assert.equal(nodeOf(graph, 'Route').label, 'Route');
});

test('expanding one type adds exactly its direct children', () => {
  const shallow = buildTypeGraph(MID_SIZE, { typeDepth: 1 });
  const opened = buildTypeGraph(MID_SIZE, { typeDepth: 1, expandTypes: ['RouteStep'] });
  const added = names(opened).filter((name) => !names(shallow).includes(name));
  assert.deepEqual(added, ['PoolConfig']);
  assert.equal(nodeOf(opened, 'RouteStep').kind, 'inline');
  assert.equal(nodeOf(opened, 'RouteStep').hidden, 0);
  assert.equal(nodeOf(opened, 'RouteStep').label, 'RouteStep');
  // Its children are stubs, so nothing below them cascades.
  assert.equal(nodeOf(opened, 'PoolConfig').kind, 'stub');
  assert.equal(nodeOf(opened, 'PoolConfig').hidden, 3);
  assert.ok(!names(opened).includes('Limits'));
  assert.deepEqual(
    opened.edges.filter((edge) => edge.from === typeNodeId('RouteStep')).map((edge) => edge.label),
    ['pool', 'delta', 'tag'],
  );
});

test('expandTypes on a name the graph never reaches changes nothing', () => {
  assert.deepEqual(
    buildTypeGraph(MID_SIZE, { expandTypes: ['Nothing'] }),
    buildTypeGraph(MID_SIZE),
  );
});

test('typeDepth: 0 collapses the whole type graph to stubs', () => {
  const graph = buildTypeGraph(MID_SIZE, { typeDepth: 0 });
  assert.ok(graph.nodes.every((node) => node.kind === 'stub'));
  assert.ok(graph.edges.every((edge) => edge.from.startsWith('fn:')));
  assert.equal(nodeOf(graph, 'Route').hidden, 2); // steps, cache
});

test('a recursive type yields a self-edge instead of an endless column', () => {
  const graph = buildTypeGraph(MID_SIZE, { typeDepth: Infinity });
  const self = graph.edges.filter((edge) => edge.from === typeNodeId('PoolPair'));
  assert.deepEqual(
    self.map((edge) => [edge.to, edge.label, edge.role]),
    [
      [typeNodeId('PoolPair'), 'next', 'field'],
    ],
  );
  assert.equal(nodeOf(graph, 'PoolPair').kind, 'inline');
});

test('signature edges carry the argument name, and returns are labelled', () => {
  const graph = buildTypeGraph(MID_SIZE);
  assert.deepEqual(
    graph.edges
      .filter((edge) => edge.from === functionNodeId('swap'))
      .map((edge) => [edge.to, edge.label, edge.role]),
    [
      [typeNodeId('Route'), 'route', 'input'],
      [typeNodeId('Route'), 'returns', 'output'],
    ],
  );
});

test('an error enum is not a type node, and an undefined name is missing', () => {
  const graph = buildTypeGraph(MID_SIZE, { typeDepth: Infinity });
  assert.ok(!names(graph).includes('ZooError'));
  assert.ok(!names(graph).includes('Ghost'));
  assert.deepEqual(graph.missing, ['Ghost']);
  assert.ok(graph.edges.every((edge) => !edge.to.includes('Ghost') && !edge.to.includes('ZooError')));
});

test('ids are the diagram ids, anchors are the docs anchors', () => {
  const graph = buildTypeGraph(MID_SIZE);
  assert.equal(typeNodeId('Route'), 'type:Route');
  assert.equal(functionNodeId('swap'), 'fn:swap');
  assert.equal(typeAnchor('Route'), 'type-Route');
  assert.ok(graph.nodes.every((node) => node.id === typeNodeId(node.name)));
  assert.ok(graph.nodes.filter((node) => node.kind === 'stub').every((node) => node.anchor.length > 0));
});

test('the graph is deterministic across runs', () => {
  const first = JSON.stringify(buildTypeGraph(MID_SIZE, { typeDepth: 1, expandTypes: ['RouteStep'] }));
  const second = JSON.stringify(buildTypeGraph(MID_SIZE, { expandTypes: ['RouteStep'], typeDepth: 1 }));
  assert.equal(first, second);
});

test('the entry point re-exports the policy', () => {
  assert.deepEqual(buildFromEntry(MID_SIZE), buildTypeGraph(MID_SIZE));
});
