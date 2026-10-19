/**
 * @file Pure SVG renderer for the diagram model (issue 494).
 *
 * Returns a string, not JSX, because the same output serves the React page
 * (inlined), file export, the CLI, and the local UI.
 */

import { VIZ_TOKENS, type VizTheme } from './tokens.ts';
import type { PositionedDiagramModel } from './layout.ts';
import { routeEdges } from './route.ts';
import { textWidth } from './metrics.ts';

import type { DiagramModel, DiagramNode, DiagramEdge } from './index.ts';

export interface RenderOptions {
  /** Prefix for all element ids, so multiple diagrams on one page don't collide. */
  idPrefix: string;
  /** Returns the href for a node id, or null if the node is not linkable. */
  hrefForNode: (nodeId: string) => string | null;
  /** Title for the <title> element (contract name/address). */
  title: string;
  /** Optional ID of an element that describes this SVG (e.g. outline details for a11y, issue 499). */
  ariaDescribedBy?: string;
  /** Optional search query for server-side filtering (?q=, issue 503). */
  query?: string;
  /** Optional focused node ID for permalinks (?focus=, issue 505). */
  focus?: string;
}

/**
 * Escapes a string for safe inclusion as XML text content or attribute value.
 * All spec strings (names, docs) are untrusted input.
 * Order matters: & must be replaced FIRST because other replacements
 * introduce & characters (in <, >, ", &apos;).
 */
function escapeXml(s: string): string {
  // XML 1.0 rejects controls and unpaired surrogates even inside escaped text.
  return Array.from(s, (char) => {
    const cp = char.codePointAt(0)!;
    return cp === 9 ||
      cp === 10 ||
      cp === 13 ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      cp >= 0x10000
      ? char
      : '\uFFFD';
  })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
export function renderDiagramSvg(model: DiagramModel, opts: RenderOptions): string {
  const { idPrefix, hrefForNode, title } = opts;

  const functionNodes = model.nodes.filter((n) => n.id.startsWith('fn:'));
  const typeNodes = model.nodes.filter((n) => n.id.startsWith('type:'));
  const groupCount = new Set(
    functionNodes.map((n) => n.id.split(':')[1]?.split('_')[0] ?? 'default'),
  ).size;

  const desc = `${functionNodes.length} functions in ${groupCount} groups, ${typeNodes.length} types, ${model.edges.length} references`;

  const describedByAttr = opts.ariaDescribedBy ? ` aria-describedby="${escapeXml(opts.ariaDescribedBy)}"` : '';
  const svgParts: string[] = [];
  svgParts.push('<svg');
  svgParts.push('  xmlns="http://www.w3.org/2000/svg"');
  svgParts.push('  role="img"');
  svgParts.push(`  aria-labelledby="${escapeXml(idPrefix)}title ${escapeXml(idPrefix)}desc"${describedByAttr}`);
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

  const focusNode = opts.focus ? model.nodes.find((n) => n.id === opts.focus) : undefined;
  const isFocusValid = Boolean(focusNode);

  const oneHopNeighbourIds = new Set<string>();
  const incidentEdgeIds = new Set<string>();

  if (focusNode) {
    for (const edge of model.edges) {
      if (edge.from === focusNode.id) {
        oneHopNeighbourIds.add(edge.to);
        incidentEdgeIds.add(`${edge.from}->${edge.to}`);
      } else if (edge.to === focusNode.id) {
        oneHopNeighbourIds.add(edge.from);
        incidentEdgeIds.add(`${edge.from}->${edge.to}`);
      }
    }
  }

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
    let edgeClass = `diagram-edge${edge.label ? ' diagram-edge--labeled' : ''}`;
    if (isFocusValid) {
      if (incidentEdgeIds.has(`${edge.from}->${edge.to}`)) {
        edgeClass += ' viz-edge--incident';
      } else {
        edgeClass += ' viz-dimmed';
      }
    }
    svgParts.push(`  <line`);
    svgParts.push(`    id="${escapeXml(edgeId)}"`);
    svgParts.push(`    class="${edgeClass}"`);
    // Endpoints as data attributes (issue 500). Node ids contain `:` (e.g.
    // `fn:foo`), which cannot go in a `#id` selector unescaped, so the detail
    // card enhancer matches incident edges by attribute value instead.
    svgParts.push(`    data-edge-from="${escapeXml(edge.from)}"`);
    svgParts.push(`    data-edge-to="${escapeXml(edge.to)}"`);
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
    const anchorId = `diagram-${escapeXml(node.id.replace(/:/g, '-'))}`;

    let focusClass = '';
    let autofocusAttr = '';
    if (isFocusValid) {
      if (node.id === focusNode!.id) {
        focusClass = ' viz-focused';
        autofocusAttr = ' autofocus=""';
      } else if (oneHopNeighbourIds.has(node.id)) {
        focusClass = ' viz-neighbour';
      } else {
        focusClass = ' viz-dimmed';
      }
    }

    const cleanQuery = opts.query?.trim().toLowerCase();
    const isMatch = cleanQuery
      ? node.id.toLowerCase().includes(cleanQuery) || node.label.toLowerCase().includes(cleanQuery)
      : true;
    const filterClass = cleanQuery && !isMatch ? ' viz-dimmed' : cleanQuery && isMatch ? ' viz-match' : '';
    const stateClass = focusClass + filterClass;
    const containerClass = stateClass ? ` class="${stateClass.trim()}"` : '';

    if (href) {
      svgParts.push(`  <a id="${anchorId}" href="${escapeXml(href)}" data-node-id="${escapeXml(node.id)}"${containerClass}${autofocusAttr}>`);
    } else {
      svgParts.push(`  <g id="${anchorId}" data-node-id="${escapeXml(node.id)}"${containerClass}${autofocusAttr}>`);
    }

    const isFunction = node.id.startsWith('fn:');
    let nodeClass = isFunction
      ? 'diagram-node diagram-node--function'
      : 'diagram-node diagram-node--type';
    if (stateClass) {
      nodeClass += stateClass;
    }

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

export interface StandaloneSvgOptions {
  theme: VizTheme | 'auto';
  provenance: { address: string; network: string; wasmHash: string };
}

/** Self-contained export; literal token colours also work in SVG editors without CSS variables. */
export function renderStandaloneSvg(
  model: PositionedDiagramModel,
  opts: StandaloneSvgOptions,
): string {
  if (!['dark', 'light', 'auto'].includes(opts.theme)) throw new RangeError('Invalid SVG theme');
  const footer = [
    `Address: ${opts.provenance.address}`,
    `Network: ${opts.provenance.network}`,
    `WASM hash: ${opts.provenance.wasmHash}`,
    'Generated by Signet from the deployed contract interface',
  ];
  const width = Math.ceil(Math.max(model.width, ...footer.map((line) => textWidth(line, 12) + 48)));
  const height = model.height + 116;
  const palette = (theme: VizTheme) => {
    const t = VIZ_TOKENS[theme];
    return `.canvas { fill: ${t.ground}; }
.node { fill: ${t.node}; stroke: ${t.edge}; }
.group { fill: none; stroke: ${t.edge}; }
.label { fill: ${t.nodeText}; }
.footer, .group-label { fill: ${t.muted}; }
.edge { fill: none; stroke: ${t.edge}; stroke-width: 1.5; }
.arrow { fill: ${t.edge}; }`;
  };
  const style = `text { font-family: monospace; font-size: 14px; }
.footer, .group-label { font-size: 12px; }
${palette(opts.theme === 'auto' ? 'light' : opts.theme)}
${opts.theme === 'auto' ? `@media (prefers-color-scheme: dark) { ${palette('dark')} }` : ''}`;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="export-title export-desc">`,
    `<title id="export-title">${escapeXml(opts.provenance.address)} contract interface</title>`,
    `<desc id="export-desc">${model.nodes.length} nodes, ${model.edges.length} references. ${escapeXml(footer.join('. '))}</desc>`,
    `<style>${style}</style>`,
    `<rect class="canvas" width="${width}" height="${height}"/>`,
    '<defs><marker id="export-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path class="arrow" d="M0,0 L8,3 L0,6 Z"/></marker></defs>',
  ];
  for (const group of model.groups) {
    parts.push(
      `<rect class="group" x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="4"/>`,
    );
    parts.push(
      `<text class="group-label" x="${group.x + 8}" y="${group.y + 16}">${escapeXml(group.name)}</text>`,
    );
  }
  for (const edge of routeEdges(model.nodes, model.edges)) {
    parts.push(
      `<polyline class="edge" points="${edge.polyline.map((p) => `${p.x},${p.y}`).join(' ')}" marker-end="url(#export-arrow)"/>`,
    );
  }
  for (const node of model.nodes) {
    parts.push(
      `<g><title>${escapeXml(node.name)}</title><rect class="node" x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="4"/>`,
    );
    parts.push(
      `<text class="label" x="${node.x + 10}" y="${node.y + node.height / 2 + 5}">${escapeXml(node.label)}</text></g>`,
    );
  }
  footer.forEach((line, index) =>
    parts.push(
      `<text class="footer" x="24" y="${model.height + 28 + index * 20}">${escapeXml(line)}</text>`,
    ),
  );
  parts.push('</svg>');
  return parts.join('\n');
}
