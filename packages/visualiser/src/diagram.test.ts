import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLLAPSE_THRESHOLD, defaultCollapsedGroups, layoutContractDiagram } from './diagram.ts';
import { buildContractGraph } from './graph.ts';
import type { ContractGraph, GraphEdge, GraphNode } from './graph.ts';
import { collapsedGroupLabel, layoutContractGraph } from './layout.ts';

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

const GROUPED = [
  'pool_create',
  'pool_deposit',
  'pool_withdraw',
  'pool_swap',
  'admin_pause',
  'admin_unpause',
  'admin_set_fee',
  'initialize',
  'upgrade',
];

test('the default policy collapses nothing at the threshold and everything above it', () => {
  const at = Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) => `fn_${i}`);
  assert.deepEqual(defaultCollapsedGroups(at), []);

  const above = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) =>
    i % 2 === 0 ? `pool_${i}` : `admin_${i}`,
  );
  assert.deepEqual(defaultCollapsedGroups(above).sort(), ['admin', 'pool']);
});

test('a collapsed group is one node labelled with its name and count', () => {
  const graph = makeGraph({
    functions: GROUPED,
    types: ['Pool'],
    edges: [
      ['fn:pool_create', 'Pool'],
      ['fn:pool_deposit', 'Pool'],
      ['fn:admin_pause', 'Pool'],
      ['fn:admin_unpause', 'Pool'],
      ['fn:admin_set_fee', 'Pool'],
      ['fn:pool_withdraw', 'Pool'],
      ['fn:pool_swap', 'Pool'],
    ],
  });
  const model = layoutContractGraph(graph, { collapsedGroups: ['pool'] });
  const groupNode = model.nodes.find((node) => node.id === 'group:pool');

  assert.ok(groupNode, 'the collapsed group has one node');
  assert.equal(groupNode.kind, 'group');
  assert.equal(groupNode.name, 'pool_* (4)');
  assert.equal(groupNode.label, 'pool_* (4)');
  assert.equal(
    model.nodes.some((node) => node.id.startsWith('fn:pool_')),
    false,
    'members are replaced, not duplicated',
  );
  assert.equal(
    model.groups.some((group) => group.name === 'pool'),
    false,
    'a collapsed group draws no box',
  );
  assert.equal(
    model.groups.some((group) => group.name === 'admin'),
    true,
  );
  assert.equal(model.groups.find((group) => group.name === 'admin')?.nodeIds.length, 3);
});

test('member edges merge onto the collapsed group node', () => {
  const graph = makeGraph({
    functions: GROUPED,
    types: ['Pool', 'Token'],
    edges: [
      ['fn:pool_create', 'Pool'],
      ['fn:pool_deposit', 'Pool'],
      ['fn:pool_withdraw', 'Token'],
      ['fn:admin_pause', 'Pool'],
      ['fn:admin_unpause', 'Pool'],
      ['fn:admin_set_fee', 'Pool'],
      ['fn:pool_swap', 'Pool'],
    ],
  });
  const model = layoutContractGraph(graph, { collapsedGroups: ['pool'] });
  const fromGroup = model.edges.filter((edge) => edge.from === 'group:pool');

  assert.deepEqual(fromGroup.map((edge) => edge.to).sort(), ['type:Pool', 'type:Token']);
  const pool = fromGroup.find((edge) => edge.to === 'type:Pool');
  assert.deepEqual(pool?.kinds, ['arg']);
  assert.ok(model.edges.every((edge) => !edge.from.startsWith('fn:pool_')));
});

test('an unknown collapsed-group name is ignored', () => {
  const plain = layoutContractGraph(makeGraph({ functions: GROUPED }));
  const unknown = layoutContractGraph(makeGraph({ functions: GROUPED }), {
    collapsedGroups: ['not-a-group'],
  });
  assert.deepEqual(unknown, plain);
});

test('layoutContractDiagram applies the default collapse policy above the threshold', () => {
  const names = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) =>
    i % 2 === 0 ? `pool_${i}` : `admin_${i}`,
  );
  const groups = names.map((name) => name);
  const spec = {
    wasmHash: 'hash',
    entries: [],
    spec: undefined,
    functions: groups.map((name) => ({
      name,
      doc: '',
      inputs: [],
      outputs: [],
    })),
    types: [],
    errors: [],
    events: [],
    warnings: [],
    sdkVersion: 'test',
  } as never;
  const collapsed = layoutContractDiagram(spec);
  assert.ok(collapsed.nodes.every((node) => node.kind === 'group'));
  const expanded = layoutContractDiagram(spec, { collapsedGroups: [] });
  assert.ok(expanded.nodes.every((node) => node.kind === 'function'));
});

test('collapsedGroupLabel distinguishes prefix and synthetic groups', () => {
  assert.equal(
    collapsedGroupLabel({ name: 'pool', kind: 'prefix', functions: ['a', 'b', 'c'] }),
    'pool_* (3)',
  );
  assert.equal(
    collapsedGroupLabel({ name: 'other', kind: 'other', functions: ['a', 'b'] }),
    'other (2)',
  );
});
