/**
 * @file Collapse and expand function groups (#502).
 *
 * The 49-function Axelar ITS fixture is past the threshold, so its groups
 * collapse; the 8-function registry is not. A collapsed group's golden is
 * in `fixtures/__golden__/collapsed/`.
 *
 * `UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test` rewrites it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import type { ContractGraph } from './graph.ts';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph } from './layout.ts';
import { FIXTURES_DIR, loadFixture } from './load-fixture.ts';
import { renderDiagramSvg } from './render.ts';
import { buildDiagramOutline, renderOutlineHtml } from './outline.ts';
import {
  canonicalExpand,
  collapseGroups,
  COLLAPSE_THRESHOLD,
  functionGroupsOf,
} from './collapse.ts';

const axelar = () => buildContractGraph(loadFixture('axelar-its'));
const GOLDEN = join(FIXTURES_DIR, '__golden__', 'collapsed', 'axelar-its.svg');

function render(expand: string[] = []) {
  const graph = collapseGroups(axelar(), { expand });
  const model = layoutContractGraph(graph);
  const svg = renderDiagramSvg(model, {
    idPrefix: 'collapsed-',
    hrefForNode: (id) =>
      id.startsWith('collapsed:') ? `?expand=${[...expand, id.slice(10)].sort().join(',')}` : null,
    title: 'axelar-its, groups collapsed',
  });
  return { graph, model, svg: `${svg}\n` };
}

test('search query matches members inside a collapsed group', () => {
  const graph = collapseGroups(axelar());
  const model = layoutContractGraph(graph);
  const svg = renderDiagramSvg(model, {
    idPrefix: 'collapsed-',
    hrefForNode: () => null,
    title: 'test',
    query: 'interchain_token_address',
  });
  assert.match(svg, /data-node-id="collapsed:interchain"[^>]*class="[^"]*viz-match[^"]*"/);
  assert.doesNotMatch(svg, /data-node-id="collapsed:interchain"[^>]*class="[^"]*viz-dimmed[^"]*"/);
  assert.match(svg, /data-node-id="collapsed:other"[^>]*class="[^"]*viz-dimmed[^"]*"/);
});

test('writes-only leaves collapsed group undimmed if any member writes', () => {
  const graph = collapseGroups(axelar());
  const model = layoutContractGraph(graph);
  const svg = renderDiagramSvg(model, {
    idPrefix: 'collapsed-',
    hrefForNode: () => null,
    title: 'test',
    writesOnly: true,
    overlays: {
      mutability: {
        marks: {
          deploy_remote_interchain_token: {
            kind: 'writes',
            evidence: 'changed',
            example: { source: 'transaction', ledger: 2, txHash: 'a'.repeat(64) },
            writingObservations: 1,
            observations: 1,
            seededOnly: false,
            staleObservations: 0,
            unversionedObservations: 0,
            seededObservations: 0,
          },
        },
        transactions: 1,
        firstLedger: 1,
        lastLedger: 2,
        staleObservations: 0,
      },
    },
  });
  assert.doesNotMatch(svg, /data-node-id="collapsed:deploy"[^>]*class="[^"]*viz-dimmed[^"]*"/);
  assert.match(svg, /data-node-id="collapsed:deploy"[^>]*data-mark="write"/);
  assert.match(svg, /data-node-id="collapsed:other"[^>]*class="[^"]*viz-dimmed[^"]*"/);
});

test('past the threshold every group collapses to one node, named for its members', () => {
  const graph = axelar();
  assert.ok(graph.nodes.filter((n) => n.kind === 'function').length > COLLAPSE_THRESHOLD);
  const { graph: collapsed, model } = render();
  const functions = collapsed.nodes.filter((n) => n.kind === 'function');
  assert.equal(functions.length, functionGroupsOf(graph).length);
  const interchain = functions.find((n) => n.id === 'collapsed:interchain')!;
  assert.equal(interchain.name, 'interchain_* (4)');
  assert.equal(functions.find((n) => n.id === 'collapsed:other')!.name, 'other (26)');
  // No member function is left, and no group box is drawn for a collapsed group.
  assert.ok(!collapsed.nodes.some((n) => n.id.startsWith('fn:')));
  assert.equal(model.groups.length, 0);
  // Every type the members used is still reached, from the group.
  const reached = (g: typeof graph) => new Set(g.edges.map((e) => e.to));
  assert.deepEqual(reached(collapsed), reached(graph));
});

test('golden: axelar-its with every group collapsed', () => {
  const { svg } = render();
  if (env.UPDATE_GOLDEN === '1') {
    mkdirSync(join(FIXTURES_DIR, '__golden__', 'collapsed'), { recursive: true });
    if (!existsSync(GOLDEN) || readFileSync(GOLDEN, 'utf8') !== svg) writeFileSync(GOLDEN, svg);
  }
  assert.ok(existsSync(GOLDEN), 'no golden; run with UPDATE_GOLDEN=1');
  assert.equal(svg, readFileSync(GOLDEN, 'utf8'), 'the collapsed diagram differs from its golden');
});

test('a collapsed group links to the URL that expands it, and says what it holds', () => {
  const { svg } = render();
  assert.match(
    svg,
    /<a id="diagram-collapsed-interchain" href="\?expand=interchain" data-node-id="collapsed:interchain" data-group-toggle="interchain"/,
  );
  assert.match(svg, /<title>interchain_\* \(4\): [^<]*interchain_token_address[^<]*\. Expand to draw them\.<\/title>/);
  assert.match(svg, /data-node-shape="dashed-outline-rect"/);
  assert.match(svg, /<desc id="collapsed-desc">49 functions in 8 groups \(8 collapsed\)/);
});

test('an expanded group draws its functions in a box; the others stay collapsed', () => {
  const { graph, model } = render(['interchain']);
  const members = functionGroupsOf(axelar()).find((g) => g.name === 'interchain')!.functions;
  for (const name of members) assert.ok(graph.nodes.some((n) => n.id === `fn:${name}`), name);
  assert.deepEqual(model.groups.map((g) => g.name), ['interchain']);
  assert.ok(graph.nodes.some((n) => n.id === 'collapsed:other'));
  // Column 0 keeps the group order: other (largest) first, then interchain.
  const column = model.nodes.filter((n) => n.column === 0).sort((a, b) => a.y - b.y);
  assert.equal(column[0]!.id, 'collapsed:other');
  assert.ok(column[1]!.id.startsWith('fn:interchain'));
});

test('below the threshold the graph is drawn as it was', () => {
  const registry = buildContractGraph(loadFixture('identity-registry'));
  assert.equal(collapseGroups(registry), registry);
  // Every group expanded is the full graph too.
  const all = functionGroupsOf(axelar()).map((g) => g.name);
  const expanded = collapseGroups(axelar(), { expand: all });
  assert.equal(expanded.nodes.length, axelar().nodes.length);
});

test('expand lists are checked against the group names, deduped and sorted', () => {
  const graph = axelar();
  assert.deepEqual(canonicalExpand('token,interchain,token', graph), ['interchain', 'token']);
  assert.deepEqual(canonicalExpand('interchain,token', graph), canonicalExpand('token,interchain', graph));
  assert.deepEqual(canonicalExpand('<script>alert(1)</script>,nope', graph), []);
  assert.deepEqual(canonicalExpand(null, graph), []);
  assert.deepEqual(canonicalExpand(['flow', ' deploy '], graph), ['deploy', 'flow']);
});

test('the outline lists a collapsed group with its members and the types it uses', () => {
  const { model } = render();
  const outline = buildDiagramOutline(model);
  const interchain = outline.find((item) => item.id === 'collapsed:interchain')!;
  assert.equal(interchain.kind, 'group');
  assert.equal(interchain.label, 'interchain_* (4), collapsed');
  assert.ok(interchain.children!.some((c) => c.kind === 'function' && c.name === 'interchain_token_address'));
  const html = renderOutlineHtml(outline, () => null);
  assert.match(html, /interchain_\* \(4\), collapsed/);
});

test('a call from a member of a collapsed group starts from the group', () => {
  const graph = collapseGroups(axelar());
  const member = functionGroupsOf(axelar()).find((g) => g.name === 'interchain')!.functions[0]!;
  const callee = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
  const model = layoutContractGraph(graph, {}, {
    calls: {
      overlay: {
        edges: [{ from: member, to: callee, transactions: 3, sandboxRuns: 0, evidence: 'auth-tree' }],
        transactions: 3,
        firstLedger: 1,
        lastLedger: 2,
        sandboxRuns: 0,
      },
    },
  } as never);
  assert.ok(model.edges.some((e) => e.from === 'collapsed:interchain' && e.call));
});

function graphWithFunctions(names: readonly string[]): ContractGraph {
  return {
    nodes: names.map((name) => ({ id: `fn:${name}`, kind: 'function', name })),
    edges: [],
    errors: [],
    events: [],
    build: undefined,
  };
}

function representedFunctions(graph: ContractGraph): string[] {
  return graph.nodes
    .filter((n) => n.kind === 'function')
    .flatMap((n) => (n.collapsed ? [...n.collapsed.members] : [n.name]));
}

test('other_* and lifecycle_* prefix groups do not collide with synthetic catch-all groups', () => {
  const names = [
    'other_a',
    'other_b',
    'other_c',
    'foo',
    'bar',
    ...Array.from({ length: 22 }, (_, i) => `pool_${i}`),
  ];
  assert.equal(names.length, 27);
  const full = graphWithFunctions(names);

  const allCollapsed = collapseGroups(full);
  const fnNodes = allCollapsed.nodes.filter((n) => n.kind === 'function');
  assert.equal(new Set(fnNodes.map((n) => n.id)).size, fnNodes.length);
  assert.equal(fnNodes.find((n) => n.id === 'collapsed:other')?.name, 'other_* (3)');
  assert.equal(fnNodes.find((n) => n.id === 'collapsed:~other')?.name, 'other (2)');
  assert.deepEqual(representedFunctions(allCollapsed).sort(), [...names].sort());

  // ?expand=other expands only other_*; ?expand=~other expands only the catch-all.
  const expandPrefix = canonicalExpand('other', full);
  const expandSynthetic = canonicalExpand('~other', full);
  assert.deepEqual(expandPrefix, ['other']);
  assert.deepEqual(expandSynthetic, ['~other']);

  const prefixExpanded = collapseGroups(full, { expand: expandPrefix });
  assert.deepEqual(representedFunctions(prefixExpanded).sort(), [...names].sort());
  assert.ok(prefixExpanded.nodes.some((n) => n.id === 'fn:other_a'));
  assert.ok(!prefixExpanded.nodes.some((n) => n.id === 'fn:foo'));
  assert.ok(prefixExpanded.nodes.some((n) => n.id === 'collapsed:~other'));

  const syntheticExpanded = collapseGroups(full, { expand: expandSynthetic });
  assert.deepEqual(representedFunctions(syntheticExpanded).sort(), [...names].sort());
  assert.ok(syntheticExpanded.nodes.some((n) => n.id === 'fn:foo'));
  assert.ok(!syntheticExpanded.nodes.some((n) => n.id === 'fn:other_a'));
  assert.ok(syntheticExpanded.nodes.some((n) => n.id === 'collapsed:other'));

  // Expanding both in layout keeps distinct group box ids.
  const bothLayout = layoutContractGraph(
    collapseGroups(full, { expand: canonicalExpand('other,~other', full) }),
  );
  assert.equal(new Set(bothLayout.groups.map((g) => g.id)).size, bothLayout.groups.length);
  assert.ok(bothLayout.groups.some((g) => g.id === 'group:other' && g.kind === 'prefix'));
  assert.ok(bothLayout.groups.some((g) => g.id === 'group:~other' && g.kind === 'other'));

  // Same disambiguation for lifecycle_* next to synthetic lifecycle.
  const lifecycleNames = [
    'lifecycle_a',
    'lifecycle_b',
    'lifecycle_c',
    '__constructor',
    'version',
    ...Array.from({ length: 22 }, (_, i) => `pool_${i}`),
  ];
  const lifecycleGraph = graphWithFunctions(lifecycleNames);
  const collapsedLifecycle = collapseGroups(lifecycleGraph);
  assert.deepEqual(representedFunctions(collapsedLifecycle).sort(), [...lifecycleNames].sort());
  assert.equal(collapsedLifecycle.nodes.find((n) => n.id === 'collapsed:lifecycle')?.name, 'lifecycle_* (3)');
  assert.equal(collapsedLifecycle.nodes.find((n) => n.id === 'collapsed:~lifecycle')?.name, 'lifecycle (2)');
  assert.deepEqual(canonicalExpand('lifecycle', lifecycleGraph), ['lifecycle']);
  assert.deepEqual(canonicalExpand('~lifecycle', lifecycleGraph), ['~lifecycle']);
});
