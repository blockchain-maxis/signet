/**
 * @file Pure SVG renderer for the diagram model (issue 494).
 *
 * Returns a string, not JSX, because the same output serves the React page
 * (inlined), file export, the CLI, and the local UI.
 */

import type { DiagramModel, DiagramNode, DiagramEdge } from './index.ts';

export interface RenderOptions {
  /** Prefix for all element ids, so multiple diagrams on one page don't collide. */
  idPrefix: string;
  /** Returns the href for a node id, or null if the node is not linkable. */
  hrefForNode: (nodeId: string) => string | null;
  /** Title for the <title> element (contract name/address). */
  title: string;
}

/**
 * Escapes a string for safe inclusion as XML text content or attribute value.
 * All spec strings (names, docs) are untrusted input.
 * Order matters: & must be replaced FIRST because other replacements
 * introduce & characters (in <, >, ", &apos;).
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&apos;');
}

/**
 * Renders a DiagramModel to an SVG string.
 *
 * The root is `<svg role="img" aria-labelledby>`, with `<title>` and `<desc>`
 * summarising counts. Every function node and type node is wrapped in `<a href>`
 * pointing to its docs anchor, carries `data-node-id`, and has an SVG
 * `<title>` with the full signature. Styling is only through classes and
 * `var(--viz-*)` custom properties.
 *
 * No inline hex colours, no `<style>` block, no `<script>`, no animation
 * elements. A standalone export adds a `<style>` block (issue 506).
 */
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

  const desc = `${functionNodes.length} functions in ${groupCount} groups, ${typeNodes.length} types, ${model.edges.length} references`;

  const svgParts: string[] = [];
  svgParts.push('<svg');
  svgParts.push('  xmlns="http://www.w3.org/2000/svg"');
  svgParts.push('  role="img"');
  svgParts.push(`  aria-labelledby="${escapeXml(idPrefix)}title ${escapeXml(idPrefix)}desc"`);
  svgParts.push('  class="contract-diagram"');
  svgParts.push('>');
  svgParts.push(`  <title id="${escapeXml(idPrefix)}title">${escapeXml(title)}</title>`);
  svgParts.push(`  <desc id="${escapeXml(idPrefix)}desc">${escapeXml(desc)}</desc>`);

  // Defs for markers (arrowheads)
  svgParts.push('  <defs>');
  svgParts.push('    <marker id="arrowhead" markerWidth="10" markerHeight="7"');
  svgParts.push('      refX="9" refY="3.5" orient="auto" markerUnits="strokeWidth">');
  svgParts.push('      <path d="M0,0 L10,3.5 L0,7 Z" class="diagram-edge-marker" />');
  svgParts.push('    </marker>');
  svgParts.push('  </defs>');

  // Edges first (so they render behind nodes)
  for (const edge of model.edges) {
    const fromNode = model.nodes.find((n) => n.id === edge.from);
    const toNode = model.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;

    // Simple straight-line edge for now; issue 487 will add proper routing with ports
    const fromX = 100;
    const fromY = 100;
    const toX = 300;
    const toY = 100;

    const edgeId = `${idPrefix}edge-${escapeXml(edge.from)}-${escapeXml(edge.to)}`;
    svgParts.push(`  <line`);
    svgParts.push(`    id="${escapeXml(edgeId)}"`);
    svgParts.push(`    class="diagram-edge${edge.label ? ' diagram-edge--labeled' : ''}"`);
    svgParts.push(`    x1="${fromX}" y1="${fromY}" x2="${toX}" y2="${toY}"`);
    svgParts.push(`    marker-end="url(#arrowhead)"`);
    if (edge.label) {
      svgParts.push(`    data-edge-label="${escapeXml(edge.label)}"`);
    }
    svgParts.push(`  />`);
  }

  // Nodes
  for (const node of model.nodes) {
    const href = hrefForNode(node.id);
    const nodeId = `${idPrefix}node-${escapeXml(node.id)}`;
    const label = escapeXml(node.label);

    if (href) {
      svgParts.push(`  <a href="${escapeXml(href)}" data-node-id="${escapeXml(node.id)}">`);
    } else {
      svgParts.push(`  <g data-node-id="${escapeXml(node.id)}">`);
    }

    const isFunction = node.id.startsWith('fn:');
    const nodeClass = isFunction ? 'diagram-node diagram-node--function' : 'diagram-node diagram-node--type';

    svgParts.push(`    <rect`);
    svgParts.push(`      id="${escapeXml(nodeId)}"`);
    svgParts.push(`      class="${nodeClass}"`);
    svgParts.push(`      x="${isFunction ? 50 : 250}"`);
    svgParts.push(`      y="${isFunction ? 50 : 150}"`);
    svgParts.push(`      width="${label.length * 8 + 20}"`);
    svgParts.push(`      height="28"`);
    svgParts.push(`      rx="4" ry="4"`);
    svgParts.push(`    />`);

    svgParts.push(`    <title>${escapeXml(node.label)}</title>`);

    svgParts.push(`    <text`);
    svgParts.push(`      class="diagram-node-label"`);
    svgParts.push(`      x="${isFunction ? 60 : 260}"`);
    svgParts.push(`      y="${isFunction ? 68 : 168}"`);
    svgParts.push(`      text-anchor="middle"`);
    svgParts.push(`      dominant-baseline="middle"`);
    svgParts.push(`    >`);
    svgParts.push(`      ${label}`);
    svgParts.push(`    </text>`);

    if (href) {
      svgParts.push(`  </a>`);
    } else {
      svgParts.push(`  </g>`);
    }
  }

  svgParts.push('</svg>');

  return svgParts.join('\n');
}