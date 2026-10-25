/**
 * @file Pure SVG renderer for the diagram model (issue 494).
 *
 * Returns a string, not JSX, because the same output serves the React page
 * (inlined), file export, the CLI, and the local UI.
 */

import { VIZ_CSS_VARIABLES, VIZ_TOKENS, type VizTheme, type VizTokenName } from './tokens.ts';
import type { PositionedDiagramModel, PositionedEdge, PositionedNode } from './layout.ts';
import { routeEdges } from './route.ts';
import { textWidth } from './metrics.ts';
import { describeCallWindow } from './observe/call-graph.ts';
import {
  EDGE_VOCABULARY,
  NODE_VOCABULARY,
  dashArray,
  markerGlyph,
  nodeShapeSvg,
  renderLegend,
  sandboxBadge,
  type EdgeKind,
  type NodeKind,
} from './vocabulary.ts';

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

/** A node as the renderer draws it: positioned, with what it is. */
interface DrawnNode extends DiagramNode {
  x: number;
  y: number;
  width: number;
  height: number;
  kind?: PositionedNode['kind'];
  typeKind?: string;
  name?: string;
}

const isPositioned = (n: DiagramNode): n is DrawnNode => {
  const p = n as Partial<DrawnNode>;
  return (
    [p.x, p.y, p.width, p.height].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    p.width! > 0 &&
    p.height! > 0
  );
};

const FONT_PX = 14;

/** The call graph footer's note on what line weight and `×N` mean. */
const WEIGHT_NOTE =
  'A heavier line is a call made more often (by thirds of the counts); ×N is how many transactions and runs made it.';
const PAD_X = 10;
const MARGIN = 24;

/**
 * Geometry for a model that has none (a bare `DiagramModel`): functions
 * stacked in one column, everything else in the next, in model order.
 */
function placeUnpositioned(model: DiagramModel): DrawnNode[] {
  const rowStep = 40;
  const widthOf = (n: DiagramNode) => Math.ceil(textWidth(n.label, FONT_PX)) + 2 * PAD_X;
  const fns = model.nodes.filter((n) => n.id.startsWith('fn:'));
  const rest = model.nodes.filter((n) => !n.id.startsWith('fn:'));
  const firstWidth = Math.max(0, ...fns.map(widthOf));
  const place = (list: DiagramNode[], x: number) =>
    list.map((n, i) => ({ ...n, x, y: MARGIN + i * rowStep, width: widthOf(n), height: 28 }));
  return [...place(fns, MARGIN), ...place(rest, MARGIN + firstWidth + 96)];
}

/** The vocabulary kind a drawn node is. */
function nodeKindOf(node: DrawnNode): NodeKind {
  switch (node.kind) {
    case 'function':
      return 'function';
    case 'missing':
      return 'stub';
    case 'callee':
    case 'callees-more':
    case 'call-anchor':
      return node.kind;
    case 'type':
      return node.typeKind === 'union' ? 'union' : node.typeKind === 'enum' ? 'enum' : 'struct';
    default:
      return node.id.startsWith('fn:') ? 'function' : 'struct';
  }
}

/** The vocabulary kind a drawn edge is: a call by its evidence, else its first spec kind. */
function edgeKindOf(edge: DiagramEdge): EdgeKind {
  const positioned = edge as Partial<PositionedEdge>;
  if (positioned.call) {
    const evidence = positioned.call.evidence;
    return evidence === null ? 'call-sandbox' : (`call-${evidence}` as EdgeKind);
  }
  const kinds = positioned.kinds ?? [];
  if (kinds.includes('arg')) return 'arg';
  if (kinds.includes('return')) return 'return';
  return 'field';
}

const cssVar = (token: VizTokenName) => `var(${VIZ_CSS_VARIABLES[token]})`;

/** Stroke width in user units: spec edges by vocabulary, calls by weight. */
function edgeStrokeWidth(edge: DiagramEdge, kind: EdgeKind): number {
  const call = (edge as Partial<PositionedEdge>).call;
  if (call) return call.weight;
  return EDGE_VOCABULARY[kind].strokeWidth === 'thin' ? 1 : 1.5;
}

/**
 * Renders a DiagramModel to an SVG string.
 *
 * The root is `<svg role="figure" aria-labelledby>`, with `<title>` and `<desc>`
 * summarising counts. Every function node and type node is wrapped in `<a href>`
 * pointing to its docs anchor, carries `data-node-id`, and has an SVG
 * `<title>` with the full signature.
 *
 * A laid-out model (`layoutContractGraph`) is drawn where the layout put it,
 * with every edge routed (`routeEdges`); a bare model gets a plain two-column
 * placement. Nodes and edges are drawn in the visual vocabulary (issue 493). A call
 * graph overlay (issue 543) adds its callee column, weighted call edges with a
 * count label, a legend for what it draws and the window it was observed in.
 *
 * Styling is only through classes and `var(--viz-*)` custom properties. No
 * inline hex colours, no `<style>` block, no `<script>`, no animation
 * elements. A standalone export adds a `<style>` block (issue 506).
 */
export function renderDiagramSvg(model: DiagramModel, opts: RenderOptions): string {
  const { idPrefix, hrefForNode, title } = opts;
  const prefix = escapeXml(idPrefix);

  const nodes: DrawnNode[] = model.nodes.every(isPositioned)
    ? (model.nodes as DrawnNode[])
    : placeUnpositioned(model);
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const edges = model.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
  const routed = routeEdges(nodes, edges);

  const functionNodes = model.nodes.filter((n) => n.id.startsWith('fn:'));
  const typeNodes = model.nodes.filter((n) => n.id.startsWith('type:'));
  const groupCount = new Set(
    functionNodes.map((n) => n.id.split(':')[1]?.split('_')[0] ?? 'default'),
  ).size;
  const calls = (model as Partial<PositionedDiagramModel>).calls;
  const callEdges = edges.filter((e) => (e as Partial<PositionedEdge>).call);
  const calleeCount = nodes.filter((n) => n.kind === 'callee').length;

  let desc = `${functionNodes.length} functions in ${groupCount} groups, ${typeNodes.length} types, ${model.edges.length - callEdges.length} references`;
  if (calls) {
    desc += `; calls ${calleeCount} other contract${calleeCount === 1 ? '' : 's'}`;
    if (calls.hidden > 0) desc += ` and ${calls.hidden} more`;
  }

  // Canvas: the layout's size, or the drawn nodes' extent plus a margin.
  const extentX = Math.max(0, ...nodes.map((n) => n.x + n.width)) + MARGIN;
  const extentY = Math.max(0, ...nodes.map((n) => n.y + n.height)) + MARGIN;
  const positioned = model as Partial<PositionedDiagramModel>;
  const bodyHeight = Math.ceil(Math.max(positioned.height ?? 0, extentY));

  // The legend and provenance line sit under a call graph.
  const legendKinds = new Set<EdgeKind | NodeKind>();
  if (calls) legendKinds.add('callee');
  for (const e of callEdges) {
    legendKinds.add(edgeKindOf(e));
    // A call the chain showed may carry an S too: explain it whenever drawn.
    if ((e as Partial<PositionedEdge>).call!.sandboxRuns > 0) legendKinds.add('call-sandbox');
  }
  if (calls && calls.hidden > 0) legendKinds.add('callees-more');
  if (nodes.some((n) => n.kind === 'call-anchor')) legendKinds.add('call-anchor');
  const provenance = calls ? describeCallWindow(calls) : '';

  // Wide enough for the diagram, and for every footer line to be read whole.
  const legendTextWidth = [...legendKinds].map((kind) =>
    kind in NODE_VOCABULARY
      ? textWidth(
          `${NODE_VOCABULARY[kind as NodeKind].prefix} — ${NODE_VOCABULARY[kind as NodeKind].label}`,
          FONT_PX,
        ) + 40
      : textWidth(EDGE_VOCABULARY[kind as EdgeKind].label, FONT_PX) + 40,
  );
  const footerTextWidth = calls
    ? Math.max(textWidth(WEIGHT_NOTE, 12), textWidth(provenance, 12), ...legendTextWidth) +
      2 * MARGIN
    : 0;
  const width = Math.ceil(Math.max(positioned.width ?? 0, extentX, footerTextWidth));

  const legend = calls
    ? renderLegend(legendKinds, {
        idPrefix: `${idPrefix}legend`,
        width: width - 2 * MARGIN,
      })
    : '';
  const legendHeight = legend ? Number(/data-legend-height="(\d+)"/.exec(legend)![1]) : 0;
  const footer = calls ? legendHeight + 3 * 20 + 8 : 0;
  const height = bodyHeight + footer;

  const describedByAttr = opts.ariaDescribedBy
    ? ` aria-describedby="${escapeXml(opts.ariaDescribedBy)}"`
    : '';
  const svgParts: string[] = [];
  svgParts.push('<svg');
  svgParts.push('  xmlns="http://www.w3.org/2000/svg"');
  // A figure, not an img: an img's children are presentational, and the
  // nodes here are links (axe's nested-interactive).
  svgParts.push('  role="figure"');
  svgParts.push(`  aria-labelledby="${prefix}title ${prefix}desc"${describedByAttr}`);
  svgParts.push('  class="contract-diagram"');
  svgParts.push(`  width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`);
  svgParts.push(
    `  font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="${FONT_PX}"`,
  );
  svgParts.push('>');
  svgParts.push(`  <title id="${prefix}title">${escapeXml(title)}</title>`);
  svgParts.push(`  <desc id="${prefix}desc">${escapeXml(desc)}</desc>`);

  // Arrowheads, one per marker the edges use, namespaced by idPrefix.
  const usedMarkers = new Set(edges.map((e) => EDGE_VOCABULARY[edgeKindOf(e)].marker));
  svgParts.push('  <defs>');
  for (const marker of ['filled-arrow', 'open-arrow', 'sandbox-arrow'] as const) {
    if (!usedMarkers.has(marker)) continue;
    svgParts.push(
      `    <marker id="${prefix}${marker}" markerWidth="8" markerHeight="8" refX="7.5" refY="3" orient="auto" markerUnits="userSpaceOnUse">${markerGlyph(marker)}</marker>`,
    );
  }
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
  for (const edge of routed) {
    const kind = edgeKindOf(edge);
    const vocab = EDGE_VOCABULARY[kind];
    const call = (edge as Partial<PositionedEdge>).call;

    const edgeId = `${idPrefix}edge-${escapeXml(edge.from)}-${escapeXml(edge.to)}`;
    let edgeClass = `diagram-edge${edge.label ? ' diagram-edge--labeled' : ''}`;
    if (call)
      edgeClass += ` diagram-edge--call diagram-edge--${kind} diagram-edge--w${call.weight}`;
    if (isFocusValid) {
      if (incidentEdgeIds.has(`${edge.from}->${edge.to}`)) {
        edgeClass += ' viz-edge--incident';
      } else {
        edgeClass += ' viz-dimmed';
      }
    }
    const dash = dashArray(vocab.dash);
    svgParts.push(`  <polyline`);
    svgParts.push(`    id="${escapeXml(edgeId)}"`);
    svgParts.push(`    class="${edgeClass}"`);
    // Endpoints as data attributes (issue 500). Node ids contain `:` (e.g.
    // `fn:foo`), which cannot go in a `#id` selector unescaped, so the detail
    // card enhancer matches incident edges by attribute value instead.
    svgParts.push(`    data-edge-from="${escapeXml(edge.from)}"`);
    svgParts.push(`    data-edge-to="${escapeXml(edge.to)}"`);
    svgParts.push(`    data-edge-kind="${kind}"`);
    if (call) svgParts.push(`    data-call-count="${call.count}"`);
    svgParts.push(`    points="${edge.polyline.map((p) => `${p.x},${p.y}`).join(' ')}"`);
    svgParts.push(
      `    fill="none" stroke="${cssVar(vocab.token)}" stroke-width="${edgeStrokeWidth(edge, kind)}"${dash ? ` stroke-dasharray="${dash}"` : ''}`,
    );
    if (vocab.marker !== 'none') svgParts.push(`    marker-end="url(#${prefix}${vocab.marker})"`);
    if (edge.label) {
      svgParts.push(`    data-edge-label="${escapeXml(edge.label)}"`);
    }
    svgParts.push(`  />`);

    if (call) {
      // The count rides the last leg, just short of the arrow; the S badge
      // sits where that leg starts.
      const end = edge.polyline[edge.polyline.length - 1]!;
      const turn = edge.polyline[edge.polyline.length - 2] ?? end;
      const calls = `${call.count} call${call.count === 1 ? '' : 's'}`;
      svgParts.push(
        `  <text class="diagram-edge-count" data-count-from="${escapeXml(edge.from)}" data-count-to="${escapeXml(edge.to)}" x="${end.x - 12}" y="${end.y - 3}" text-anchor="end" font-size="12" fill="${cssVar('muted')}" stroke="${cssVar('ground')}" stroke-width="3" paint-order="stroke"><title>${calls}</title>×${call.count}</text>`,
      );
      if (call.sandboxRuns > 0) svgParts.push(`  ${sandboxBadge(turn.x, turn.y)}`);
    }
  }

  // Nodes
  for (const node of nodes) {
    const href = hrefForNode(node.id);
    const nodeId = `${idPrefix}node-${node.id}`;
    const label = escapeXml(node.label);
    const anchorId = `diagram-${escapeXml(node.id.replace(/:/g, '-'))}`;
    const kind = nodeKindOf(node);

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
    const filterClass =
      cleanQuery && !isMatch ? ' viz-dimmed' : cleanQuery && isMatch ? ' viz-match' : '';
    const stateClass = focusClass + filterClass;
    const containerClass = stateClass ? ` class="${stateClass.trim()}"` : '';

    if (href) {
      svgParts.push(
        `  <a id="${anchorId}" href="${escapeXml(href)}" data-node-id="${escapeXml(node.id)}"${containerClass}${autofocusAttr}>`,
      );
    } else {
      svgParts.push(
        `  <g id="${anchorId}" data-node-id="${escapeXml(node.id)}"${containerClass}${autofocusAttr}>`,
      );
    }

    const isFunction = kind === 'function';
    let nodeClass = isFunction
      ? 'diagram-node diagram-node--function'
      : kind === 'struct' || kind === 'union' || kind === 'enum'
        ? 'diagram-node diagram-node--type'
        : `diagram-node diagram-node--${kind}`;
    if (stateClass) {
      nodeClass += stateClass;
    }

    // The outline in the node's vocabulary shape; a callee is ringed in the
    // observed colour, as its edges are.
    const shape = nodeShapeSvg(
      NODE_VOCABULARY[kind].shape,
      node.x,
      node.y,
      node.width,
      node.height,
      {
        id: nodeId,
        className: nodeClass,
        ...(kind === 'callee' && { stroke: 'observed' as const }),
      },
    );
    svgParts.push(`    ${shape}`);

    svgParts.push(`    <title>${escapeXml(node.name ?? node.label)}</title>`);

    svgParts.push(`    <text`);
    svgParts.push(`      class="diagram-node-label"`);
    svgParts.push(`      x="${node.x + PAD_X}"`);
    svgParts.push(`      y="${node.y + node.height / 2}"`);
    svgParts.push(`      dominant-baseline="central"`);
    svgParts.push(
      `      fill="${cssVar(kind === 'call-anchor' || kind === 'callees-more' || kind === 'stub' ? 'muted' : 'nodeText')}"`,
    );
    svgParts.push(`    >`);
    svgParts.push(`      ${label}`);
    svgParts.push(`    </text>`);

    if (href) {
      svgParts.push(`  </a>`);
    } else {
      svgParts.push(`  </g>`);
    }
  }

  if (calls) {
    svgParts.push(
      `  <g class="diagram-call-footer" transform="translate(${MARGIN - 8} ${bodyHeight})">`,
    );
    svgParts.push(`    ${legend}`);
    svgParts.push(
      `    <text class="diagram-call-weight" x="8" y="${legendHeight + 12}" font-size="12" fill="${cssVar('muted')}">${WEIGHT_NOTE}</text>`,
    );
    svgParts.push(
      `    <text class="diagram-call-provenance" x="8" y="${legendHeight + 32}" font-size="12" fill="${cssVar('muted')}">${escapeXml(provenance)}</text>`,
    );
    svgParts.push('  </g>');
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
