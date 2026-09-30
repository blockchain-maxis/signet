/**
 * @file Pure SVG renderer for the diagram model (#494, design §4.2).
 *
 * Returns a string, not JSX, because the same output serves the React page
 * (inlined), file export, the CLI, and the local UI.
 */

import type { DiagramModel, DiagramNode, DiagramEdge } from './index.ts';

export interface RenderOptions {
  idPrefix: string;
  hrefForNode: (nodeId: string) => string | null;
  title: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '\u0026amp;')
    .replace(/</g, '\u0026lt;')
    .replace(/>/g, '\u0026gt;')
    .replace(/"/g, '\u0026quot;')
    .replace(/'/g, '\u0026apos;');
}

export function renderDiagramSvg(
  model: DiagramModel,
  opts: RenderOptions,
): string {
  const { idPrefix, hrefForNode, title } = opts;

  const functionNodes = model.nodes.filter((n) => n.id.startsWith('fn:'));
  const typeNodes = model.nodes.filter((n) => n.id.startsWith('type:'));
  const groupCount = new Set(
    functionNodes.map((n) => n.id.split(':')[1]?.split('_')[0] ?? 'default'),
  ).size;

  const desc = functionNodes.length + ' functions in ' + groupCount + ' groups, ' + typeNodes.length + ' types, ' + model.edges.length + ' references';

  const svgParts = [];
  svgParts.push('<svg');
  svgParts.push('  xmlns="http://www.w3.org/2000/svg"');
  svgParts.push('  role="img"');
  svgParts.push('  aria-labelledby="' + escapeXml(idPrefix) + 'title ' + escapeXml(idPrefix) + 'desc"');
  svgParts.push('  class="contract-diagram"');
  svgParts.push('>');
  svgParts.push('  <title id="' + escapeXml(idPrefix) + 'title">' + escapeXml(title) + '</title>');
  svgParts.push('  <desc id="' + escapeXml(idPrefix) + 'desc">' + escapeXml(desc) + '</desc>');

  svgParts.push('  <defs>');
  svgParts.push('    <marker id="arrowhead" markerWidth="10" markerHeight="7"');
  svgParts.push('      refX="9" refY="3.5" orient="auto" markerUnits="strokeWidth">');
  svgParts.push('      <path d="M0,0 L10,3.5 L0,7 Z" class="diagram-edge-marker" />');
  svgParts.push('    </marker>');
  svgParts.push('  </defs>');

  for (const edge of model.edges) {
    const fromNode = model.nodes.find((n) => n.id === edge.from);
    const toNode = model.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;

    const fromX = 100;
    const fromY = 100;
    const toX = 300;
    const toY = 100;

    const edgeId = idPrefix + 'edge-' + escapeXml(edge.from) + '-' + escapeXml(edge.to);
    svgParts.push('  <line');
    svgParts.push('    id="' + escapeXml(edgeId) + '"');
    svgParts.push('    class="diagram-edge' + (edge.label ? ' diagram-edge--labeled' : '') + '"');
    svgParts.push('    x1="' + fromX + '" y1="' + fromY + '" x2="' + toX + '" y2="' + toY + '"');
    svgParts.push('    marker-end="url(#arrowhead)"');
    if (edge.label) {
      svgParts.push('    data-edge-label="' + escapeXml(edge.label) + '"');
    }
    svgParts.push('  />');
  }

  for (const node of model.nodes) {
    const href = hrefForNode(node.id);
    const nodeId = idPrefix + 'node-' + escapeXml(node.id);
    const label = escapeXml(node.label);

    if (href) {
      svgParts.push('  <a href="' + escapeXml(href) + '" data-node-id="' + escapeXml(node.id) + '">');
    } else {
      svgParts.push('  <g data-node-id="' + escapeXml(node.id) + '">');
    }

    const isFunction = node.id.startsWith('fn:');
    const nodeClass = isFunction ? 'diagram-node diagram-node--function' : 'diagram-node diagram-node--type';

    svgParts.push('    <rect');
    svgParts.push('      id="' + escapeXml(nodeId) + '"');
    svgParts.push('      class="' + nodeClass + '"');
    svgParts.push('      x="' + (isFunction ? 50 : 250) + '"');
    svgParts.push('      y="' + (isFunction ? 50 : 150) + '"');
    svgParts.push('      width="' + (label.length * 8 + 20) + '"');
    svgParts.push('      height="28"');
    svgParts.push('      rx="4" ry="4"');
    svgParts.push('    />');

    svgParts.push('    <title>' + escapeXml(node.label) + '</title>');

    svgParts.push('    <text');
    svgParts.push('      class="diagram-node-label"');
    svgParts.push('      x="' + (isFunction ? 60 : 260) + '"');
    svgParts.push('      y="' + (isFunction ? 68 : 168) + '"');
    svgParts.push('      text-anchor="middle"');
    svgParts.push('      dominant-baseline="middle"');
    svgParts.push('    >');
    svgParts.push('      ' + label);
    svgParts.push('    </text>');

    if (href) {
      svgParts.push('  </a>');
    } else {
      svgParts.push('  </g>');
    }
  }

  svgParts.push('</svg>');

  return svgParts.join('\n');
}
