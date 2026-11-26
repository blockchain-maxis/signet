import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph } from './layout.ts';
import { loadFixture } from './load-fixture.ts';
import { renderDiagramSvg } from './render.ts';
import { buildDiagramOutline, renderOutlineHtml } from './outline.ts';
import type { DiagramModel } from './index.ts';

test('the blend-pool-v1 SVG contains a legend with one row per kind present and none for absent kinds', () => {
  const spec = loadFixture('blend-pool-v1');
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);
  const svg = renderDiagramSvg(model, {
    idPrefix: 'blend-',
    hrefForNode: () => null,
    title: 'blend-pool-v1',
  });

  // Contains the legend group
  assert.ok(svg.includes('data-viz-legend=""'), 'SVG must contain the legend');
  assert.ok(svg.includes('class="diagram-legend-footer"'), 'SVG must contain diagram-legend-footer');

  // Present kinds in blend-pool-v1 (has functions, structs, union, and arg/return/field edges)
  assert.ok(svg.includes('data-node-kind="function"'), 'function node kind present');
  assert.ok(svg.includes('data-node-kind="struct"'), 'struct node kind present');
  assert.ok(svg.includes('data-node-kind="union"'), 'union node kind present');
  assert.ok(svg.includes('data-edge-label="arg"'), 'arg edge kind present');
  assert.ok(svg.includes('data-edge-label="return"'), 'return edge kind present');
  assert.ok(svg.includes('data-edge-label="field"'), 'field edge kind present');

  // Absent kinds (blend-pool-v1 has no enums, stubs, callees or calls)
  assert.ok(!svg.includes('data-node-kind="enum"'), 'enum absent');
  assert.ok(!svg.includes('data-node-kind="stub"'), 'stub absent');
  assert.ok(!svg.includes('data-node-kind="callee"'), 'callee absent');
  assert.ok(!svg.includes('data-node-kind="callees-more"'), 'callees-more absent');
  assert.ok(!svg.includes('data-node-kind="call-anchor"'), 'call-anchor absent');
  assert.ok(!svg.includes('data-node-kind="collapsed-group"'), 'collapsed-group absent');
  assert.ok(!svg.includes('data-edge-label="observed"'), 'observed edge absent');
  assert.ok(!svg.includes('data-edge-label="observed-write"'), 'observed-write absent');
  assert.ok(!svg.includes('data-edge-label="call-auth-tree"'), 'call-auth-tree absent');
  assert.ok(!svg.includes('data-edge-label="call-event"'), 'call-event absent');
  assert.ok(!svg.includes('data-edge-label="call-footprint"'), 'call-footprint absent');
  assert.ok(!svg.includes('data-edge-label="call-sandbox"'), 'call-sandbox absent');
});

test('the registry fallback list (0 edges) has no legend', () => {
  const spec = loadFixture('identity-registry');
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);
  const fallbackModel: DiagramModel = {
    nodes: model.nodes.filter((n) => n.kind === 'function'),
    edges: [],
  };

  const svg = renderDiagramSvg(fallbackModel, {
    idPrefix: 'registry-',
    hrefForNode: () => null,
    title: 'identity-registry',
  });

  assert.ok(!svg.includes('data-viz-legend'), 'fallback list must have no legend');
  assert.ok(!svg.includes('diagram-legend-footer'), 'fallback list must have no legend footer');
});

test('the outline includes the key list in Diagram as text when edges are present, and none for fallback list', () => {
  const blendSpec = loadFixture('blend-pool-v1');
  const blendGraph = buildContractGraph(blendSpec);
  const blendModel = layoutContractGraph(blendGraph);
  const blendOutline = buildDiagramOutline(blendModel);
  const blendHtml = renderOutlineHtml(blendOutline, () => null);

  assert.ok(blendHtml.includes('outline-group-name">key</span>'), 'outline must contain key section');
  assert.ok(blendHtml.includes('<span>fn — function</span>'));
  assert.ok(blendHtml.includes('<span>struct — struct</span>'));
  assert.ok(blendHtml.includes('<span>argument (solid, filled arrow)</span>'));

  const registrySpec = loadFixture('identity-registry');
  const registryGraph = buildContractGraph(registrySpec);
  const registryModel = layoutContractGraph(registryGraph);
  const fallbackModel: DiagramModel = {
    nodes: registryModel.nodes.filter((n) => n.kind === 'function'),
    edges: [],
  };
  const fallbackOutline = buildDiagramOutline(fallbackModel);
  const fallbackHtml = renderOutlineHtml(fallbackOutline, () => null);

  assert.ok(!fallbackHtml.includes('outline-group-name">key</span>'), 'fallback outline must not have key');
});
