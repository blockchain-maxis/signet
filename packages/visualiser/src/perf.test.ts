import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildContractGraph, type ContractGraph, type GraphEdge, type GraphNode } from './graph.ts';
import { MAX_NODES, diagramDecision } from './decide.ts';
import { MAX_RAW_NODES, layoutContractGraph, type PositionedDiagramModel } from './layout.ts';
import { renderDiagramSvg } from './render.ts';
import { loadFixture } from './load-fixture.ts';

/**
 * Performance budgets for layout and SVG rendering (#507, E-27).
 *
 * Hard ceilings from the issue specification:
 * - Median layout + SVG render over 20 runs: <= 50 ms
 * - Rendered SVG byte size: <= 150 KB (153,600 bytes)
 * - Cached DiagramModel JSON byte size: <= 100 KB (102,400 bytes)
 * - 5,000-node pathological graph guard: < 10 ms
 */
export const BUDGET_LAYOUT_RENDER_MEDIAN_MS = 50;
export const BUDGET_SVG_MAX_BYTES = 150 * 1024;
export const BUDGET_MODEL_JSON_MAX_BYTES = 100 * 1024;
export const BUDGET_GUARD_5000_MAX_MS = 10;

const RUNS = 20;

interface PerfMeasurement {
  label: string;
  medianMs: number;
  svgBytes: number;
  jsonBytes: number;
  model: PositionedDiagramModel;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Generates a synthetic ContractGraph with `nodeCount` nodes (half functions in
 * prefix groups, half user-defined types across multiple ranks) and dense edges.
 */
function generateGraph(nodeCount: number): ContractGraph {
  const fnCount = Math.floor(nodeCount / 2);
  const typeCount = nodeCount - fnCount;
  const prefixes = ['token', 'pool', 'vault', 'admin', 'oracle', 'gov'];

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (let i = 0; i < fnCount; i++) {
    const prefix = prefixes[i % prefixes.length]!;
    const name = `${prefix}_action_${i}`;
    nodes.push({ id: `fn:${name}`, kind: 'function', name });
  }

  for (let i = 0; i < typeCount; i++) {
    const name = `TypePayload_${i}`;
    nodes.push({
      id: `type:${name}`,
      kind: 'type',
      name,
      typeKind: i % 3 === 0 ? 'union' : i % 2 === 0 ? 'struct' : 'enum',
    });
  }

  if (typeCount > 0) {
    for (let i = 0; i < fnCount; i++) {
      const fnId = nodes[i]!.id;
      const t1 = `type:TypePayload_${i % typeCount}`;
      const t2 = `type:TypePayload_${(i * 3 + 1) % typeCount}`;
      edges.push({
        id: `${fnId}->${t1}`,
        from: fnId,
        to: t1,
        kinds: ['arg'],
        roles: [{ kind: 'arg', path: t1, via: 'input' }],
      });
      if (t2 !== t1) {
        edges.push({
          id: `${fnId}->${t2}`,
          from: fnId,
          to: t2,
          kinds: ['return'],
          roles: [{ kind: 'return', path: t2 }],
        });
      }
    }

    // Multi-column type-to-type edges
    for (let i = 0; i + 1 < Math.min(typeCount, 20); i += 2) {
      const from = `type:TypePayload_${i}`;
      const to = `type:TypePayload_${i + 1}`;
      edges.push({
        id: `${from}->${to}`,
        from,
        to,
        kinds: ['field'],
        roles: [{ kind: 'field', path: to, via: 'nested' }],
      });
    }
  }

  return { nodes, edges, errors: [], events: [], build: undefined };
}

function measureLayoutAndRender(label: string, graph: ContractGraph): PerfMeasurement {
  // Warmup pass
  let lastModel = layoutContractGraph(graph);
  let lastSvg = renderDiagramSvg(lastModel, {
    idPrefix: 'perf-',
    hrefForNode: (id) => `#${id}`,
    title: label,
  });

  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    lastModel = layoutContractGraph(graph);
    lastSvg = renderDiagramSvg(lastModel, {
      idPrefix: 'perf-',
      hrefForNode: (id) => `#${id}`,
      title: label,
    });
    samples.push(performance.now() - start);
  }

  const medianMs = Number(median(samples).toFixed(3));
  const svgBytes = Buffer.byteLength(lastSvg, 'utf8');
  const jsonBytes = Buffer.byteLength(JSON.stringify(lastModel), 'utf8');

  return { label, medianMs, svgBytes, jsonBytes, model: lastModel };
}

function formatSummary(m: PerfMeasurement): string {
  return `[${m.label}] median=${m.medianMs}ms (budget <= ${BUDGET_LAYOUT_RENDER_MEDIAN_MS}ms), svg=${m.svgBytes}B (${(m.svgBytes / 1024).toFixed(2)}KB, budget <= ${BUDGET_SVG_MAX_BYTES}B), json=${m.jsonBytes}B (${(m.jsonBytes / 1024).toFixed(2)}KB, budget <= ${BUDGET_MODEL_JSON_MAX_BYTES}B)`;
}

function assertWithinBudgets(m: PerfMeasurement): void {
  const summary = formatSummary(m);

  assert.ok(
    m.medianMs <= BUDGET_LAYOUT_RENDER_MEDIAN_MS,
    `Layout + render median time exceeded budget: ${summary}`,
  );
  assert.ok(
    m.svgBytes <= BUDGET_SVG_MAX_BYTES,
    `Rendered SVG size exceeded budget: ${summary}`,
  );
  assert.ok(
    m.jsonBytes <= BUDGET_MODEL_JSON_MAX_BYTES,
    `Cached DiagramModel JSON size exceeded budget: ${summary}`,
  );
}

test('perf budget: large real-contract fixture (axelar-its) stays within time, SVG, and JSON budgets', (t) => {
  const spec = loadFixture('axelar-its');
  const graph = buildContractGraph(spec);
  assert.ok(graph.nodes.length >= 40, `expected >= 40 nodes in axelar-its, got ${graph.nodes.length}`);

  const m = measureLayoutAndRender('axelar-its', graph);
  t.diagnostic(formatSummary(m));
  assertWithinBudgets(m);
});

test('perf budget: generated 60-node ceiling graph stays within time, SVG, and JSON budgets', (t) => {
  const graph = generateGraph(MAX_NODES);
  assert.equal(graph.nodes.length, 60);

  const m = measureLayoutAndRender('generated-60-nodes', graph);
  t.diagnostic(formatSummary(m));
  assertWithinBudgets(m);
});

test('guard: layoutContractGraph refuses graphs above 500 raw nodes without laying out', () => {
  const graph = generateGraph(MAX_RAW_NODES + 1);
  assert.equal(graph.nodes.length, 501);

  const model = layoutContractGraph(graph);
  assert.equal(model.tooLarge, true);
  assert.equal(model.status, 'too-large');
  assert.equal(model.rawNodeCount, 501);
  assert.equal(model.nodes.length, 0);
  assert.equal(model.edges.length, 0);
  assert.equal(model.groups.length, 0);

  const decision = diagramDecision(graph, model);
  assert.deepEqual(decision, { kind: 'too-large', nodeCount: 501 });
});

test('guard: a generated 5,000-node graph returns in < 10 ms via the guard', () => {
  const graph = generateGraph(5_000);
  assert.equal(graph.nodes.length, 5_000);

  const start = performance.now();
  const model = layoutContractGraph(graph);
  const elapsedMs = performance.now() - start;

  assert.equal(model.tooLarge, true);
  assert.equal(model.status, 'too-large');
  assert.equal(model.rawNodeCount, 5_000);
  assert.equal(model.nodes.length, 0);
  assert.ok(
    elapsedMs < BUDGET_GUARD_5000_MAX_MS,
    `5,000-node guard took ${elapsedMs.toFixed(3)}ms (budget < ${BUDGET_GUARD_5000_MAX_MS}ms)`,
  );
});
