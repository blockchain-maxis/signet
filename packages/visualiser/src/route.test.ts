import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeEdges,
  type Point,
  type RoutableEdge,
  type RoutableNode,
  type RoutedEdge,
} from './route.ts';

const NODE_WIDTH = 80;
const NODE_HEIGHT = 36;

function node(id: string, column: number, row: number): RoutableNode {
  return {
    id,
    label: id,
    x: 24 + column * 160,
    y: 32 + row * 64,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  };
}

const midSizeNodes = [
  node('mint', 0, 0),
  node('transfer', 0, 1),
  node('balance', 0, 2),
  node('MintRequest', 1, 0),
  node('TransferRequest', 1, 1),
  node('Account', 1, 2),
  node('Asset', 2, 0),
  node('Metadata', 2, 2),
];

const midSizeEdges: RoutableEdge[] = [
  { from: 'mint', to: 'MintRequest' },
  { from: 'transfer', to: 'TransferRequest' },
  { from: 'balance', to: 'Account' },
  { from: 'mint', to: 'Asset' },
  { from: 'TransferRequest', to: 'Asset' },
  { from: 'Account', to: 'Metadata' },
];

const largeNodes = [
  ...Array.from({ length: 7 }, (_, row) => node(`fn-${row}`, 0, row)),
  ...Array.from({ length: 6 }, (_, row) => node(`request-${row}`, 1, row)),
  ...Array.from({ length: 5 }, (_, row) => node(`record-${row}`, 2, row)),
  ...Array.from({ length: 4 }, (_, row) => node(`leaf-${row}`, 3, row)),
];

const largeEdges: RoutableEdge[] = [
  ...Array.from({ length: 6 }, (_, row) => ({ from: `fn-${row}`, to: `request-${row}` })),
  ...Array.from({ length: 5 }, (_, row) => ({ from: `request-${row}`, to: `record-${row}` })),
  ...Array.from({ length: 4 }, (_, row) => ({ from: `record-${row}`, to: `leaf-${row}` })),
  { from: 'fn-0', to: 'record-4' },
  { from: 'fn-1', to: 'leaf-3' },
  { from: 'fn-2', to: 'leaf-0' },
  { from: 'record-3', to: 'request-3', back: true },
  { from: 'leaf-1', to: 'request-5', back: true },
  { from: 'record-2', to: 'record-2', back: true },
];

for (const [name, nodes, edges] of [
  ['mid-size', midSizeNodes, midSizeEdges],
  ['large', largeNodes, largeEdges],
] as const) {
  test(`${name} fixture routes never intersect unrelated nodes`, () => {
    const routed = routeEdges(nodes, edges);
    assert.equal(routed.length, edges.length);
    for (const edge of routed) {
      assert.ok(edge.polyline.length >= 2);
      assertOrthogonal(edge.polyline);
      for (let index = 1; index < edge.polyline.length; index += 1) {
        const start = edge.polyline[index - 1]!;
        const end = edge.polyline[index]!;
        for (const candidate of nodes) {
          if (candidate.id === edge.from || candidate.id === edge.to) continue;
          assert.equal(
            segmentIntersectsRectangle(start, end, candidate),
            false,
            `${edge.from} -> ${edge.to} intersects ${candidate.id}`,
          );
        }
      }
    }
  });
}

test('incoming and outgoing ports are unique and ordered by the opposite node y', () => {
  const nodes = [
    node('source', 0, 1),
    node('high', 1, 0),
    node('middle', 1, 1),
    node('low', 1, 2),
    node('other-high', 0, 0),
    node('other-low', 0, 2),
    node('target', 2, 1),
  ];
  const edges = routeEdges(nodes, [
    { from: 'source', to: 'low' },
    { from: 'source', to: 'high' },
    { from: 'source', to: 'middle' },
    { from: 'other-low', to: 'target' },
    { from: 'other-high', to: 'target' },
    { from: 'source', to: 'target' },
  ]);

  const outgoing = edges
    .filter((edge) => edge.from === 'source')
    .sort((left, right) => targetY(left, nodes) - targetY(right, nodes));
  const sourcePorts = outgoing.map((edge) => edge.polyline[0]!.y);
  assert.deepEqual(
    sourcePorts,
    [...sourcePorts].sort((left, right) => left - right),
  );
  assert.equal(new Set(sourcePorts).size, sourcePorts.length);

  const incoming = edges.filter((edge) => edge.to === 'target');
  const targetPorts = incoming.map((edge) => edge.polyline.at(-1)!.y);
  assert.equal(new Set(targetPorts).size, targetPorts.length);
});

test('routing is deterministic and leaves its inputs unchanged', () => {
  const nodesBefore = structuredClone(largeNodes);
  const edgesBefore = structuredClone(largeEdges);
  const expected = JSON.stringify(routeEdges(largeNodes, largeEdges));
  for (let run = 0; run < 100; run += 1) {
    assert.equal(JSON.stringify(routeEdges(largeNodes, largeEdges)), expected);
  }
  assert.deepEqual(largeNodes, nodesBefore);
  assert.deepEqual(largeEdges, edgesBefore);
});

test('back edges loop above the columns and still use side ports', () => {
  const nodes = [node('recursive', 1, 1), node('owner', 0, 0)];
  const [edge] = routeEdges(nodes, [{ from: 'recursive', to: 'owner', back: true }]);
  assert.ok(edge);
  assert.equal(edge.polyline[0]!.x, nodes[0]!.x + nodes[0]!.width);
  assert.equal(edge.polyline.at(-1)!.x, nodes[1]!.x);
  assert.ok(
    Math.min(...edge.polyline.map((point) => point.y)) < Math.min(...nodes.map((item) => item.y)),
  );
});

function assertOrthogonal(polyline: readonly Point[]): void {
  for (let index = 1; index < polyline.length; index += 1) {
    const start = polyline[index - 1]!;
    const end = polyline[index]!;
    assert.ok(start.x === end.x || start.y === end.y, 'every segment must be orthogonal');
  }
}

function segmentIntersectsRectangle(start: Point, end: Point, rectangle: RoutableNode): boolean {
  if (start.x === end.x) {
    return (
      start.x >= rectangle.x &&
      start.x <= rectangle.x + rectangle.width &&
      Math.max(Math.min(start.y, end.y), rectangle.y) <=
        Math.min(Math.max(start.y, end.y), rectangle.y + rectangle.height)
    );
  }
  return (
    start.y >= rectangle.y &&
    start.y <= rectangle.y + rectangle.height &&
    Math.max(Math.min(start.x, end.x), rectangle.x) <=
      Math.min(Math.max(start.x, end.x), rectangle.x + rectangle.width)
  );
}

function targetY(edge: RoutedEdge, nodes: readonly RoutableNode[]): number {
  return nodes.find((item) => item.id === edge.to)!.y;
}
