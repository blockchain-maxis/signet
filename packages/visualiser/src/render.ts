/**
 * @file Pure SVG renderer for the diagram model (issue 494, issue 502).
 *
 * Returns a string, not JSX, because the same output serves the React page
 * (inlined), file export, the CLI, and the local UI.
 */

import { VIZ_TOKENS, type VizTheme } from './tokens.ts';
import type { PositionedDiagramModel, PositionedGroup, PositionedNode } from './layout.ts';
import { routeEdges } from './route.ts';
import { textWidth } from './metrics.ts';

import type { DiagramModel, DiagramNode } from './index.ts';

/** A group's identity for link building, without its geometry. */
export interface GroupRef {
  id: string;
  name: string;
}

export interface RenderOptions {
  /** Prefix for all element ids, so multiple diagrams on one page don't collide. */
  idPrefix: string;
  /** Returns the href for a node id, or null if the node is not linkable. */
  hrefForNode: (nodeId: string) => string | null;
  /**
   * Returns the href for a group's collapse control, or null to draw the group
   * without one. The target URL is the page state with that group collapsed
   * (issue 502).
   */
  hrefForGroup?: (group: GroupRef) => string | null;
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

/** Geometry a positioned node carries; absent on a bare `DiagramModel`. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxOf(node: DiagramNode): Box | undefined {
  const candidate = node as Partial<PositionedNode>;
  if (
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number'
  ) {
    return {
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
    };
  }
  return undefined;
}

function kindOf(node: DiagramNode): 'function' | 'type' | 'group' | 'missing' {
  const kind = (node as { kind?: string }).kind;
  if (kind === 'function' || kind === 'type' || kind === 'group' || kind === 'missing') return kind;
  if (node.id.startsWith('fn:')) return 'function';
  if (node.id.startsWith('group:')) return 'group';
  if (node.id.startsWith('type:')) return 'type';
  return 'missing';
}

/**
 * Renders a DiagramModel to an SVG string.
 *
 * A positioned model (`PositionedDiagramModel`) draws at the layout's
 * coordinates, with its group boxes; a bare model keeps the renderer's
 * original fixed coordinates. Every function, type and collapsed-group node is
 * wrapped in `<a href>` when `hrefForNode` returns a target, carries
 * `data-node-id`, and has an SVG `<title>` with the full label. A group box's
 * header is a link back to the state that collapses it (issue 502), so a JS-free
 * reader can toggle a group in both directions.
 *
 * Styling is only through classes and `var(--viz-*)` custom properties. No
 * inline hex colours, no `<style>` block, no `<script>`, no animation
 * elements. A standalone export adds a `<style>` block (issue 506).
 */
export function renderDiagramSvg(model: DiagramModel, opts: RenderOptions): string {
  const { idPrefix, hrefForNode, hrefForGroup, title } = opts;
  const positioned = (
    'width' in model && 'height' in model ? model : null
  ) as PositionedDiagramModel | null;
  const groups: readonly PositionedGroup[] =
    positioned !== null && Array.isArray(positioned.groups) ? positioned.groups : [];

  const functionNodes = model.nodes.filter((n) => kindOf(n) === 'function');
  const typeNodes = model.nodes.filter((n) => kindOf(n) === 'type');
  const groupNodes = model.nodes.filter((n) => kindOf(n) === 'group');
  const prefixGroups = new Set(
    functionNodes.map((n) => n.id.split(':')[1]?.split('_')[0] ?? 'default'),
  ).size;
  const groupsShown =
    groups.length + groupNodes.length > 0 ? groups.length + groupNodes.length : prefixGroups;
  const desc = `${functionNodes.length} functions in ${groupsShown} groups, ${typeNodes.length} types, ${model.edges.length} references`;

  const svgParts: string[] = [];
  svgParts.push('<svg');
  svgParts.push('  xmlns="http://www.w3.org/2000/svg"');
  svgParts.push('  role="img"');
  svgParts.push(`  aria-labelledby="${escapeXml(idPrefix)}title ${escapeXml(idPrefix)}desc"`);
  svgParts.push('  class="contract-diagram"');
  if (positioned !== null) {
    svgParts.push(`  viewBox="0 0 ${positioned.width} ${positioned.height}"`);
    svgParts.push('  width="100%"');
  }
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

  // Group boxes sit behind the edges and their members.
  for (const group of groups) {
    svgParts.push(`  <g class="diagram-group" data-group-id="${escapeXml(group.id)}">`);
    svgParts.push(
      `    <rect class="diagram-group-box" x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="4" ry="4" />`,
    );
    svgParts.push('  </g>');
  }

  // Edges first (so they render behind nodes)
  for (const edge of model.edges) {
    const fromNode = model.nodes.find((n) => n.id === edge.from);
    const toNode = model.nodes.find((n) => n.id === edge.to);
    if (!fromNode || !toNode) continue;

    const fromBox = boxOf(fromNode);
    const toBox = boxOf(toNode);
    // Positioned diagrams route between node ports; a bare model keeps the
    // renderer's original stub coordinates until edge routing is wired in.
    const fromX = fromBox ? fromBox.x + fromBox.width : 100;
    const fromY = fromBox ? fromBox.y + fromBox.height / 2 : 100;
    const toX = toBox ? toBox.x : 300;
    const toY = toBox ? toBox.y + toBox.height / 2 : 100;

    const edgeId = `${idPrefix}edge-${escapeXml(edge.from)}-${escapeXml(edge.to)}`;
    svgParts.push(`  <line`);
    svgParts.push(`    id="${escapeXml(edgeId)}"`);
    svgParts.push(`    class="diagram-edge${edge.label ? ' diagram-edge--labeled' : ''}"`);
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
    const kind = kindOf(node);
    const groupName =
      kind === 'group' && node.id.startsWith('group:') ? node.id.slice('group:'.length) : null;

    if (href) {
      svgParts.push(`  <a href="${escapeXml(href)}" data-node-id="${escapeXml(node.id)}"`);
      if (groupName !== null) {
        svgParts.push(`    data-expand-group="${escapeXml(groupName)}"`);
        svgParts.push(`    data-group-toggle="${escapeXml(groupName)}"`);
      }
      svgParts.push('  >');
    } else {
      svgParts.push(`  <g data-node-id="${escapeXml(node.id)}">`);
    }

    const nodeClass =
      kind === 'function'
        ? 'diagram-node diagram-node--function'
        : kind === 'group'
          ? 'diagram-node diagram-node--group'
          : 'diagram-node diagram-node--type';
    const box = boxOf(node);
    const x = box ? box.x : kind === 'function' ? 50 : 250;
    const y = box ? box.y : kind === 'function' ? 50 : 150;
    const width = box ? box.width : label.length * 8 + 20;
    const height = box ? box.height : 28;

    svgParts.push(`    <rect`);
    svgParts.push(`      id="${escapeXml(nodeId)}"`);
    svgParts.push(`      class="${nodeClass}"`);
    svgParts.push(`      x="${x}"`);
    svgParts.push(`      y="${y}"`);
    svgParts.push(`      width="${width}"`);
    svgParts.push(`      height="${height}"`);
    svgParts.push(`      rx="4" ry="4"`);
    svgParts.push(`    />`);

    svgParts.push(`    <title>${label}</title>`);

    svgParts.push(`    <text`);
    svgParts.push(`      class="diagram-node-label"`);
    svgParts.push(`      x="${box ? x + width / 2 : kind === 'function' ? 60 : 260}"`);
    svgParts.push(`      y="${box ? y + height / 2 : kind === 'function' ? 68 : 168}"`);
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

  // Group controls last, so they stay clickable above the edges.
  for (const group of groups) {
    const href = hrefForGroup?.(group) ?? null;
    const label = `${group.name} (${group.nodeIds.length})`;
    const header = headerHeightOf(group, model);
    const y = group.y + header / 2;
    const text = escapeXml(label);
    if (href) {
      svgParts.push(
        `  <a class="diagram-group-toggle" href="${escapeXml(href)}" data-collapse-group="${escapeXml(group.name)}" data-group-toggle="${escapeXml(group.name)}">`,
      );
      svgParts.push(`    <title>Collapse ${escapeXml(group.name)}</title>`);
    } else {
      svgParts.push('  <g class="diagram-group-toggle">');
    }
    svgParts.push(
      `    <text class="diagram-group-label" x="${group.x + 8}" y="${y}" dominant-baseline="middle">${text}</text>`,
    );
    if (href) {
      svgParts.push(
        `    <text class="diagram-group-control" x="${group.x + group.width - 12}" y="${y}" text-anchor="end" dominant-baseline="middle">−</text>`,
      );
      svgParts.push('  </a>');
    } else {
      svgParts.push('  </g>');
    }
  }

  svgParts.push('</svg>');

  return svgParts.join('\n');
}

/** Header height of a group box: the gap between its top and its first member. */
function headerHeightOf(group: PositionedGroup, model: DiagramModel): number {
  const first = model.nodes.find((node) => node.id === group.nodeIds[0]);
  const box = first ? boxOf(first) : undefined;
  return box ? Math.max(0, box.y - group.y) : 28;
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
