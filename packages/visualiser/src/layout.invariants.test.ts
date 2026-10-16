/**
 * @file Layout invariants across every fixture and seeded random graphs (#488,
 * backlog E-08).
 *
 * The unit tests in `layout.test.ts` pin particular cases. This suite checks
 * properties that must hold for every contract, so a later tweak to the layout
 * cannot quietly break them:
 *
 * - no two nodes overlap;
 * - every node lies inside `[0, width] × [0, height]`;
 * - every graph edge has exactly one positioned edge;
 * - no label is given less room than its text needs at a size of at least
 *   `MIN_TEXT_PX`, and the layout refuses a smaller font;
 * - the output is deterministic.
 *
 * Inputs: the real-contract fixtures in `fixtures/`, the `@signet/spec` WASM
 * fixtures listed in its manifest, and generated graphs of 1 to 80 nodes from a
 * fixed seed list, so CI is deterministic. A failing generated case names its
 * seed and size; `generateGraph(seed, size)` rebuilds it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec } from '@signet/spec';
import type { SpecType } from '@signet/spec';
import { buildContractGraph } from './graph.ts';
import type { ContractGraph, GraphEdge, GraphEdgeKind, GraphNode } from './graph.ts';
import { layoutContractGraph } from './layout.ts';
import type { LayoutGeometryOptions, PositionedDiagramModel } from './layout.ts';
import { MIN_TEXT_PX, textWidth } from './metrics.ts';
import { FIXTURES_DIR, loadFixture } from './load-fixture.ts';

const SPEC_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'fixtures');

/** Every graph is laid out with each of these: the defaults, the smallest text, and no slack. */
const GEOMETRIES: readonly { name: string; opts: LayoutGeometryOptions }[] = [
  { name: 'defaults', opts: {} },
  { name: 'minimum text', opts: { fontSizePx: MIN_TEXT_PX } },
  {
    name: 'tight',
    opts: {
      fontSizePx: MIN_TEXT_PX,
      nodePaddingX: 0,
      maxNodeWidth: 96,
      columnGutter: 0,
      rowGap: 0,
      groupGap: 0,
      groupPadding: 0,
      margin: 0,
    },
  },
];

/** The layout's defaults for the two options the text check reads. */
const DEFAULT_FONT_PX = 14;
const DEFAULT_PADDING_X = 10;

// --- the inputs --------------------------------------------------------------

/** `fixtures/<name>.spec.json`, decoded offline (#483). */
function visualiserFixtures(): { name: string; graph: ContractGraph }[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.spec.json'))
    .map((f) => f.slice(0, -'.spec.json'.length))
    .sort()
    .map((name) => ({ name, graph: buildContractGraph(loadFixture(name)) }));
}

/** Manifest entries that exist to test the reader's errors: there is no spec to lay out. */
const UNREADABLE_SPEC_FIXTURES: ReadonlySet<string> = new Set(['no_spec', 'corrupt_section']);

/** The `@signet/spec` WASM fixtures its manifest lists, except the reader's error cases. */
function specFixtures(): { name: string; graph: ContractGraph }[] {
  const manifest = JSON.parse(readFileSync(join(SPEC_FIXTURES, 'manifest.json'), 'utf8')) as Record<
    string,
    { file: string }
  >;
  return Object.keys(manifest)
    .filter((name) => !UNREADABLE_SPEC_FIXTURES.has(name))
    .sort()
    .map((name) => ({
      name: `spec/${name}`,
      graph: buildContractGraph(
        parseContractSpec(readFileSync(join(SPEC_FIXTURES, manifest[name]!.file))),
      ),
    }));
}

/** mulberry32: a small, well-known 32-bit PRNG. Same seed, same sequence, on every engine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PREFIXES = ['get', 'set', 'pool', 'admin', 'swap'] as const;
const LIFECYCLE = ['__constructor', 'initialize', 'upgrade', 'version'] as const;
const TYPE_KINDS: readonly SpecType['kind'][] = ['struct', 'union', 'enum'];
/**
 * A function name is a Soroban symbol, at most 32 characters. The longest
 * generated one, `admin_with_a_long_name_n79`, is 26: long enough to truncate
 * under a narrow `maxNodeWidth`, short enough to stay valid.
 */
const LONG_PART = 'with_a_long_name';

/**
 * A random but valid `ContractGraph` of exactly `size` nodes (1 to 80).
 *
 * - At least one function. Names share a few prefixes, so some contracts group
 *   and some do not; lifecycle names and names long enough to truncate occur.
 * - Types are structs, unions and enums. Now and then a reference is to a
 *   type the spec does not define (a `missing` node, as from a hand-edited spec).
 * - A function points at the types in its signature (`arg`, `return`). A
 *   struct or union points at the types its fields hold (`field`), itself
 *   included, so cycles and self-loops occur. Enums hold nothing. Nothing
 *   points at a function.
 * - One edge per (from, to) pair, id `<from>-><to>`, with every role it plays.
 */
function generateGraph(seed: number, size: number): ContractGraph {
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

  const fnCount = 1 + Math.floor(rand() * size);
  const nodes: GraphNode[] = [];
  const lifecycle = new Set<string>();
  for (let i = 0; i < fnCount; i++) {
    const roll = rand();
    let name = `f${i}`; // no underscore: never forms a group
    if (roll < 0.06) {
      const entry = pick(LIFECYCLE);
      if (!lifecycle.has(entry)) name = entry; // each entrypoint at most once
      lifecycle.add(entry);
    } else if (roll >= 0.16) {
      name = `${pick(PREFIXES)}_${roll < 0.3 ? `${LONG_PART}_` : ''}n${i}`;
    }
    nodes.push({ id: `fn:${name}`, kind: 'function', name });
  }
  for (let i = fnCount; i < size; i++) {
    const name = `T${i}`;
    nodes.push(
      rand() < 0.08
        ? { id: `type:${name}`, kind: 'missing', name }
        : { id: `type:${name}`, kind: 'type', name, typeKind: pick(TYPE_KINDS) },
    );
  }

  const types = nodes.filter((n) => n.kind !== 'function');
  const edges = new Map<string, { from: string; to: string; kinds: GraphEdgeKind[] }>();
  const link = (from: string, to: string, kind: GraphEdgeKind) => {
    const id = `${from}->${to}`;
    const edge = edges.get(id);
    if (!edge) edges.set(id, { from, to, kinds: [kind] });
    else if (!edge.kinds.includes(kind)) edge.kinds.push(kind);
  };
  if (types.length > 0) {
    for (const node of nodes) {
      if (node.kind === 'function') {
        const refs = Math.floor(rand() * 4);
        for (let r = 0; r < refs; r++)
          link(node.id, pick(types).id, rand() < 0.7 ? 'arg' : 'return');
      } else if (node.kind === 'type' && node.typeKind !== 'enum') {
        const refs = Math.floor(rand() * 3);
        for (let r = 0; r < refs; r++) link(node.id, pick(types).id, 'field');
      }
    }
  }

  const graphEdges: GraphEdge[] = [...edges.entries()].map(([id, { from, to, kinds }]) => ({
    id,
    from,
    to,
    kinds,
    roles: kinds.map((kind) =>
      kind === 'return'
        ? { kind, path: to.slice('type:'.length) }
        : { kind, path: to.slice('type:'.length), via: 'x' },
    ),
  }));
  return { nodes, edges: graphEdges, errors: [], events: [], build: undefined };
}

/** Fixed seeds: changing this list changes what CI checks, so only ever add to it. */
const SEEDS = [1, 2, 3, 7, 42, 99, 488, 1009, 2026, 31337, 65537, 0x5eed];
/** Sizes from the smallest graph to the 80-node ceiling. */
const SIZES = [1, 2, 3, 5, 8, 13, 21, 34, 55, 80];

// --- the invariants ----------------------------------------------------------

/** Assert every invariant of one laid-out graph. `where` prefixes every message. */
function assertInvariants(
  graph: ContractGraph,
  opts: LayoutGeometryOptions,
  model: PositionedDiagramModel,
  where: string,
): void {
  // Every graph node is positioned once.
  assert.deepEqual(
    model.nodes.map((n) => n.id).sort(),
    graph.nodes.map((n) => n.id).sort(),
    `${where}: one positioned node per graph node`,
  );

  // Inside the canvas.
  for (const n of model.nodes) {
    assert.ok(
      n.x >= 0 && n.y >= 0 && n.x + n.width <= model.width && n.y + n.height <= model.height,
      `${where}: ${n.id} at (${n.x}, ${n.y}) size ${n.width}×${n.height} ` +
        `leaves the ${model.width}×${model.height} canvas`,
    );
  }

  // No overlap. Touching edges are allowed (a zero row gap stacks nodes flush).
  const nodes = [...model.nodes].sort((a, b) => a.x - b.x || a.y - b.y);
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]!;
      if (b.x >= a.x + a.width) break; // sorted by x: nothing further right can overlap a
      const overlap = b.y < a.y + a.height && a.y < b.y + b.height;
      assert.ok(!overlap, `${where}: ${a.id} and ${b.id} overlap`);
    }
  }

  // Every graph edge has exactly one positioned edge, between the same nodes.
  const positioned = new Map(model.edges.map((e) => [e.id, e] as const));
  assert.equal(positioned.size, model.edges.length, `${where}: positioned edge ids are unique`);
  assert.equal(model.edges.length, graph.edges.length, `${where}: no edge added or dropped`);
  for (const edge of graph.edges) {
    const p = positioned.get(edge.id);
    assert.ok(p, `${where}: edge ${edge.id} has no positioned edge`);
    assert.equal(p.from, edge.from, `${where}: ${edge.id} source`);
    assert.equal(p.to, edge.to, `${where}: ${edge.id} target`);
  }

  // Text: each label gets the full width it needs at the layout's font size,
  // and that size is never below MIN_TEXT_PX.
  const fontPx = opts.fontSizePx ?? DEFAULT_FONT_PX;
  const paddingX = opts.nodePaddingX ?? DEFAULT_PADDING_X;
  assert.ok(fontPx >= MIN_TEXT_PX, `${where}: font ${fontPx}px is below ${MIN_TEXT_PX}px`);
  for (const n of model.nodes) {
    const needed = Math.ceil(textWidth(n.label, fontPx)) + 2 * paddingX;
    assert.ok(
      n.width >= needed,
      `${where}: ${n.id} is ${n.width}px wide, its label "${n.label}" needs ${needed}px ` +
        `at ${fontPx}px`,
    );
    assert.ok(n.height >= fontPx, `${where}: ${n.id} is shorter than its ${fontPx}px text`);
    if (opts.maxNodeWidth !== undefined) {
      assert.ok(n.width <= opts.maxNodeWidth, `${where}: ${n.id} is wider than maxNodeWidth`);
    }
  }
}

/** Lay `graph` out with every geometry, check the invariants and that a rerun is identical. */
function checkGraph(graph: ContractGraph, where: string): void {
  for (const { name, opts } of GEOMETRIES) {
    const at = `${where}, ${name} geometry`;
    const model = layoutContractGraph(graph, opts);
    assertInvariants(graph, opts, model, at);
    // Deterministic: a second run, and a run over a fresh copy of the input, give the same bytes.
    const again = JSON.stringify(layoutContractGraph(graph, opts));
    assert.equal(again, JSON.stringify(model), `${at}: a second layout differs`);
    const copy = JSON.stringify(layoutContractGraph(structuredClone(graph), opts));
    assert.equal(copy, JSON.stringify(model), `${at}: a copy of the graph lays out differently`);
  }
}

// --- fixtures ----------------------------------------------------------------

test('every fixture in fixtures/ holds the layout invariants', () => {
  const fixtures = visualiserFixtures();
  assert.ok(fixtures.length >= 3);
  for (const { name, graph } of fixtures) checkGraph(graph, `fixture ${name}`);
});

test('every @signet/spec WASM fixture holds the layout invariants', () => {
  const fixtures = specFixtures();
  assert.ok(
    fixtures.some((f) => f.name === 'spec/types_zoo'),
    'types_zoo, with its nested types',
  );
  for (const { name, graph } of fixtures) checkGraph(graph, `fixture ${name}`);
});

test('no fixture lays out with text below MIN_TEXT_PX: a smaller font is refused', () => {
  for (const { name, graph } of [...visualiserFixtures(), ...specFixtures()]) {
    for (const fontSizePx of [MIN_TEXT_PX - 1, MIN_TEXT_PX - 0.5, 0, Number.NaN]) {
      assert.throws(
        () => layoutContractGraph(graph, { fontSizePx }),
        RangeError,
        `${name}: fontSizePx ${fontSizePx}`,
      );
    }
  }
});

// --- generated graphs ----------------------------------------------------------

test('the generator is deterministic and builds graphs of the requested size', () => {
  for (const seed of SEEDS) {
    for (const size of SIZES) {
      const graph = generateGraph(seed, size);
      assert.equal(graph.nodes.length, size, `seed ${seed}, size ${size}`);
      assert.deepEqual(generateGraph(seed, size), graph, `seed ${seed}, size ${size}`);
      assert.equal(new Set(graph.nodes.map((n) => n.id)).size, size, `seed ${seed}: unique ids`);
      assert.equal(new Set(graph.edges.map((e) => e.id)).size, graph.edges.length);
    }
  }
});

test('the generated graphs cover the shapes the layout has to handle', () => {
  const graphs = SEEDS.flatMap((seed) => SIZES.map((size) => generateGraph(seed, size)));
  const edges = graphs.flatMap((g) => g.edges);
  assert.ok(
    edges.some((e) => e.from === e.to),
    'a self-loop',
  );
  assert.ok(
    graphs.some((g) => layoutContractGraph(g).edges.some((e) => e.back && e.from !== e.to)),
    'a cycle across types',
  );
  assert.ok(
    graphs.some((g) => layoutContractGraph(g).groups.length > 0),
    'a grouped contract',
  );
  assert.ok(
    graphs.some((g) => g.nodes.some((n) => n.kind === 'missing')),
    'a missing type',
  );
  assert.ok(
    graphs.some((g) =>
      layoutContractGraph(g, { maxNodeWidth: 160 }).nodes.some((n) => n.truncated),
    ),
    'a truncated label',
  );
  assert.ok(
    graphs.some((g) => new Set(layoutContractGraph(g).nodes.map((n) => n.column)).size >= 4),
    'four or more columns',
  );
});

for (const seed of SEEDS) {
  test(`generated graphs of ${SIZES[0]} to ${SIZES.at(-1)} nodes hold the invariants (seed ${seed})`, () => {
    for (const size of SIZES) {
      checkGraph(
        generateGraph(seed, size),
        `seed ${seed}, ${size} nodes (rebuild with generateGraph(${seed}, ${size}))`,
      );
    }
  });
}
