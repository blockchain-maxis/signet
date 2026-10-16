/**
 * @file Golden SVG snapshot tests (#495, backlog E-15).
 *
 * Determinism is the diagram's central promise (design §2.2): the same
 * `wasmHash` must draw the same bytes everywhere. Each fixture's rendered SVG
 * is committed under `fixtures/__golden__/<name>.svg` and compared here byte
 * for byte, so a change that moves, renames or restyles anything has to update
 * a golden, and the review diff shows exactly what changed.
 *
 * A fixture renders the way the contract page will (#498): spec, graph,
 * layout, then `diagramDecision`. A `draw` decision renders the laid-out
 * model. `too-simple` and `too-large` have no graph to draw, so the golden
 * holds the list-mode fallback: the function nodes alone, in the grouped
 * order of column 0, with no type nodes and no edges.
 *
 * `UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test` rewrites the
 * goldens and removes any golden whose fixture is gone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import { diagramDecision, type DiagramDecision } from './decide.ts';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph, type PositionedDiagramModel } from './layout.ts';
import { renderDiagramSvg } from './render.ts';
import { typeAnchor } from './type-graph.ts';
import { FIXTURES_DIR, loadFixture, readFixture } from './load-fixture.ts';
import type { DiagramModel } from './index.ts';

const GOLDEN_DIR = join(FIXTURES_DIR, '__golden__');
const GOLDEN_EXT = '.svg';
const UPDATE = env.UPDATE_GOLDEN === '1';
const UPDATE_COMMAND = 'UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test';

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.spec.json'))
    .map((f) => f.slice(0, -'.spec.json'.length))
    .sort();
}

function goldenNames(): string[] {
  if (!existsSync(GOLDEN_DIR)) return [];
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(GOLDEN_EXT))
    .map((f) => f.slice(0, -GOLDEN_EXT.length))
    .sort();
}

function goldenPath(name: string): string {
  return join(GOLDEN_DIR, `${name}${GOLDEN_EXT}`);
}

/** Repo-relative path, for failure messages. */
function shownPath(name: string): string {
  return `packages/visualiser/fixtures/__golden__/${name}${GOLDEN_EXT}`;
}

/**
 * Docs anchors on the contract page: functions are `fn-<name>` (#450), types
 * use `typeAnchor`. A missing type has no section to link to.
 */
function hrefsFor(model: PositionedDiagramModel): (nodeId: string) => string | null {
  const byId = new Map(model.nodes.map((n) => [n.id, n] as const));
  return (nodeId) => {
    const node = byId.get(nodeId);
    if (node?.kind === 'function') return `#fn-${node.name}`;
    if (node?.kind === 'type') return `#${typeAnchor(node.name)}`;
    return null;
  };
}

/**
 * The list-mode fallback: column 0 only, top to bottom. The layout already
 * puts the functions in grouped order there (largest group first, spec order
 * inside a group), the same order the docs list them in.
 */
function listModel(model: PositionedDiagramModel): DiagramModel {
  const functions = model.nodes
    .filter((n) => n.kind === 'function')
    .sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : 1));
  return { nodes: functions, edges: [] };
}

/** Render a fixture as the page would: the graph if it is worth drawing, the list if not. */
function renderFixture(name: string): { decision: DiagramDecision; svg: string } {
  const fixture = readFixture(name);
  const graph = buildContractGraph(loadFixture(name));
  const model = layoutContractGraph(graph);
  const decision = diagramDecision(graph, model);
  const svg = renderDiagramSvg(decision.kind === 'draw' ? model : listModel(model), {
    idPrefix: `${name}-`,
    hrefForNode: hrefsFor(model),
    title: `${name} (${fixture.network} ${fixture.address})`,
  });
  // One trailing newline, so the committed file is a well-formed text file.
  return { decision, svg: `${svg}\n` };
}

/** A line as it reads in a message: quoted, so stray `\r` or spaces show up. */
function showLine(line: string | undefined): string {
  return line === undefined ? '(end of file)' : JSON.stringify(line);
}

/** Where `actual` first departs from `expected`, as a 1-based line with both versions. */
function firstDifference(expected: string, actual: string): string {
  const want = expected.split('\n');
  const got = actual.split('\n');
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i] !== got[i]) {
      return [
        `first difference at line ${i + 1}:`,
        `  golden:   ${showLine(want[i])}`,
        `  rendered: ${showLine(got[i])}`,
      ].join('\n');
    }
  }
  return 'the files differ, but no line does';
}

// --- one golden per fixture ---------------------------------------------------

for (const name of fixtureNames()) {
  test(`golden: ${name} renders byte-for-byte as ${shownPath(name)}`, () => {
    const { svg } = renderFixture(name);
    const path = goldenPath(name);

    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      if (!existsSync(path) || readFileSync(path, 'utf8') !== svg) writeFileSync(path, svg);
      return;
    }

    if (!existsSync(path)) {
      assert.fail(`${name}: no golden at ${shownPath(name)}.\nCreate it with: ${UPDATE_COMMAND}`);
    }
    const golden = readFileSync(path, 'utf8');
    if (golden !== svg) {
      assert.fail(
        `${name}: the rendered SVG differs from ${shownPath(name)}.\n` +
          `${firstDifference(golden, svg)}\n` +
          `If the change is intended, update the golden with: ${UPDATE_COMMAND}`,
      );
    }
  });
}

test('every golden belongs to a fixture', () => {
  const fixtures = new Set(fixtureNames());
  const orphans = goldenNames().filter((name) => !fixtures.has(name));
  if (UPDATE) {
    for (const name of orphans) rmSync(goldenPath(name));
    return;
  }
  assert.deepEqual(
    orphans.map(shownPath),
    [],
    `goldens without a fixture; remove them with: ${UPDATE_COMMAND}`,
  );
});

// --- what the goldens hold ----------------------------------------------------

test('the registry is too simple to draw: its golden is the function list, not a graph', () => {
  const { decision, svg } = renderFixture('identity-registry');
  assert.equal(decision.kind, 'too-simple');
  assert.equal((svg.match(/diagram-node--function/g) ?? []).length, 8);
  assert.ok(!svg.includes('diagram-node--type'), 'no type nodes');
  assert.ok(!svg.includes('<line'), 'no edges');
});

test('a contract worth drawing renders its types and edges', () => {
  const drawn = fixtureNames()
    .map((name) => ({ name, ...renderFixture(name) }))
    .filter((r) => r.decision.kind === 'draw');
  assert.ok(drawn.length > 0, 'at least one fixture is drawn as a graph');
  for (const { name, svg } of drawn) {
    assert.ok(svg.includes('diagram-node--type'), `${name}: type nodes`);
    assert.ok(svg.includes('<line'), `${name}: edges`);
  }
});

test('rendering a fixture twice gives the same bytes', () => {
  for (const name of fixtureNames()) {
    assert.equal(renderFixture(name).svg, renderFixture(name).svg, name);
  }
});

test('a golden mismatch names the first differing line, both versions of it', () => {
  assert.equal(
    firstDifference('<svg>\n  <a/>\n</svg>\n', '<svg>\n  <b/>\n</svg>\n'),
    'first difference at line 2:\n  golden:   "  <a/>"\n  rendered: "  <b/>"',
  );
  assert.match(firstDifference('<svg>\r\n', '<svg>\n'), /golden: {3}"<svg>\\r"/);
  assert.match(firstDifference('<svg>', '<svg>\n<g/>'), /golden: {3}\(end of file\)/);
});
