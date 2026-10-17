import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph } from './layout.ts';
import { loadFixture } from './load-fixture.ts';
import {
  buildDiagramOutline,
  collectOutlineEdgeIds,
  renderOutlineHtml,
  type OutlineNode,
} from './outline.ts';
import { typeAnchor } from './type-graph.ts';

test('mid-size fixture: every edge in the graph appears exactly once in the outline', () => {
  const spec = loadFixture('blend-pool-v1');
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);

  assert.ok(model.edges.length > 0, 'mid-size fixture has edges');

  const outline = buildDiagramOutline(model);
  const collectedEdgeIds = collectOutlineEdgeIds(outline);

  // Every edge in the graph appears exactly once in the outline
  assert.equal(
    collectedEdgeIds.length,
    model.edges.length,
    `expected ${model.edges.length} edges in outline, got ${collectedEdgeIds.length}`,
  );

  const modelEdgeIds = new Set(model.edges.map((e) => e.id));
  const seenEdgeIds = new Set<string>();

  for (const edgeId of collectedEdgeIds) {
    assert.ok(modelEdgeIds.has(edgeId), `edge ${edgeId} from outline should exist in graph model`);
    assert.ok(!seenEdgeIds.has(edgeId), `edge ${edgeId} must appear exactly once in the outline`);
    seenEdgeIds.add(edgeId);
  }

  assert.equal(seenEdgeIds.size, model.edges.length);
});

test('outline structure: groups -> functions -> uses with argument/return -> nested types', () => {
  const spec = loadFixture('blend-pool-v1');
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);
  const outline = buildDiagramOutline(model);

  // Verify group structure
  const groupNames = outline.map((g) => g.name);
  assert.ok(groupNames.includes('other'));
  assert.ok(groupNames.includes('set'));
  assert.ok(groupNames.includes('new'));
  assert.ok(groupNames.includes('lifecycle'));
  assert.ok(groupNames.includes('types'));

  // Find 'submit' function inside 'other' group
  const otherGroup = outline.find((g) => g.name === 'other');
  assert.ok(otherGroup);
  const submitFn = otherGroup.children?.find((fn) => fn.name === 'submit');
  assert.ok(submitFn);
  assert.equal(submitFn.kind, 'function');
  assert.equal(submitFn.children?.length, 2);

  const requestType = submitFn.children?.find((t) => t.name === 'Request');
  assert.ok(requestType);
  assert.equal(requestType.role, 'argument');
  assert.equal(requestType.edgeId, 'fn:submit->type:Request');

  const positionsType = submitFn.children?.find((t) => t.name === 'Positions');
  assert.ok(positionsType);
  assert.equal(positionsType.role, 'return');
  assert.equal(positionsType.edgeId, 'fn:submit->type:Positions');

  // Verify types group for types not attached to functions
  const typesGroup = outline.find((g) => g.name === 'types');
  assert.ok(typesGroup);
  const poolDataKey = typesGroup.children?.find((t) => t.name === 'PoolDataKey');
  assert.ok(poolDataKey);
  assert.equal(poolDataKey.children?.length, 2);

  const userReserveKey = poolDataKey.children?.find((t) => t.name === 'UserReserveKey');
  assert.ok(userReserveKey);
  assert.equal(userReserveKey.role, 'field');
  assert.equal(userReserveKey.edgeId, 'type:PoolDataKey->type:UserReserveKey');
});

test('renderOutlineHtml renders accessible html with docs anchor links', () => {
  const spec = loadFixture('blend-pool-v1');
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);
  const outline = buildDiagramOutline(model);

  const hrefForNode = (nodeId: string) => {
    if (nodeId.startsWith('fn:')) return `#fn-${nodeId.slice(3)}`;
    if (nodeId.startsWith('type:')) return `#${typeAnchor(nodeId.slice(5))}`;
    return null;
  };

  const html = renderOutlineHtml(outline, hrefForNode);

  assert.ok(html.startsWith('<ul class="diagram-outline">'));
  assert.ok(html.endsWith('</ul>'));

  // Anchors linked properly
  assert.ok(html.includes('<a href="#fn-submit">submit</a>'));
  assert.ok(html.includes('<a href="#type-Request">Request</a> (argument)'));
  assert.ok(html.includes('<a href="#type-Positions">Positions</a> (return)'));
  assert.ok(html.includes('uses <a href="#type-Request">Request</a> (argument), <a href="#type-Positions">Positions</a> (return)'));

  // Type-level field connections
  assert.ok(html.includes('<a href="#type-PoolDataKey">PoolDataKey</a>'));
  assert.ok(html.includes('<a href="#type-UserReserveKey">UserReserveKey</a> (field)'));
});

test('axelar-its fixture: every edge in the graph appears exactly once in the outline', () => {
  const spec = loadFixture('axelar-its');
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);

  const outline = buildDiagramOutline(model);
  const collectedEdgeIds = collectOutlineEdgeIds(outline);

  assert.equal(collectedEdgeIds.length, model.edges.length);
  const seen = new Set<string>();
  for (const id of collectedEdgeIds) {
    assert.ok(!seen.has(id), `edge ${id} duplicated`);
    seen.add(id);
  }
  assert.equal(seen.size, model.edges.length);
});

test('identity-registry fixture (0 edges): builds outline with 0 edge IDs', () => {
  const spec = loadFixture('identity-registry');
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);

  const outline = buildDiagramOutline(model);
  const collectedEdgeIds = collectOutlineEdgeIds(outline);

  assert.equal(collectedEdgeIds.length, 0);
  assert.ok(outline.length > 0);
  const html = renderOutlineHtml(outline, (id) => `#${id}`);
  assert.ok(html.includes('identity-registry') || html.includes('other') || html.includes('lifecycle'));
});
