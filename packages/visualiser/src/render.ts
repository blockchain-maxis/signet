/**
 * @file Pure SVG renderer for the diagram model (issue 494).
 *
 * Returns a string, not JSX, because the same output serves the React page
 * (inlined), file export, the CLI, and the local UI.
 */

import {
  VIZ_CSS_VARIABLES,
  VIZ_TOKEN_NAMES,
  VIZ_TOKENS,
  literalColourRules,
  type VizTheme,
  type VizTokenName,
} from './tokens.ts';
import { groupFunctions } from './group.ts';
import {
  HEAT_FONT_PX,
  MARK_SLOT,
  type CallSummary,
  type PositionedDiagramModel,
  type PositionedEdge,
  type PositionedNode,
} from './layout.ts';
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
  WRITE_MARK_VOCABULARY,
  type DiagramKind,
  type EdgeKind,
  type NodeKind,
  type WriteMark,
} from './vocabulary.ts';
import type { MutabilityMark } from '@signet/spec';

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
  /** Dim every function the read/write overlay does not mark as writing (?writes=1, issue 512). */
  writesOnly?: boolean;
  /**
   * How the drawn interface differs from a previous one (issue 580), by node
   * id: a badge on each added or changed node. Removed nodes are not drawn,
   * so the caller lists them.
   */
  diff?: Readonly<Record<string, 'added' | 'changed'>>;
  /** Optional focused node ID for permalinks (?focus=, issue 505). */
  focus?: string;
  /** Overlays drawn over the layout, which stays as it is (design §4.2). */
  overlays?: {
    /** Read/write marks on the functions (issue 512). */
    mutability?: MutabilityOverlayInput;
  };
}

/**
 * The read/write overlay (issue 512): one mark per function by name, and what the
 * marks were observed from, which the diagram states under itself.
 */
export interface MutabilityOverlayInput {
  readonly marks: Readonly<Record<string, MutabilityMark>>;
  /** Transactions that decided marks, and their ledger range. */
  readonly transactions: number;
  readonly firstLedger: number | null;
  readonly lastLedger: number | null;
  /** Local sandbox runs that decided marks (issue 580). */
  readonly sandboxRuns?: number;
  /** Calls to an earlier code version, not counted. */
  readonly staleObservations?: number;
  /** Days of transactions the RPC keeps. Default 7. */
  readonly retentionDays?: number;
  /** A transaction's page, for the detail card's evidence (issue 500). */
  readonly txHref?: (txHash: string) => string;
  /**
   * The marks come only from local sandbox runs (issue 580): each says so,
   * and the provenance line names no transactions or RPC.
   */
  readonly local?: boolean;
}

/** A mark's write-mark vocabulary entry. */
export function writeMarkOf(mark: MutabilityMark | undefined): WriteMark {
  if (mark?.kind === 'writes') return 'write';
  if (mark?.kind === 'no-writes-seen') return 'read';
  return 'unknown';
}

/** A mark in words: what the function was seen doing, and how it is known. */
export function markText(mark: MutabilityMark | undefined): string {
  const kind = writeMarkOf(mark);
  const base = kind === 'write' ? 'writes' : kind === 'read' ? 'no writes seen' : 'not observed';
  if (mark && mark.kind !== 'unknown' && mark.seededOnly) return `${base} (seeded state)`;
  return base;
}

const MARK_SIZE = 14;

/** The mark glyph in its square, at (x, y): greyscale-legible by glyph and fill. */
function markBadge(kind: WriteMark, x: number, y: number): string {
  const vocab = WRITE_MARK_VOCABULARY[kind];
  const square =
    vocab.square === 'none'
      ? ''
      : `<rect x="${x}" y="${y}" width="${MARK_SIZE}" height="${MARK_SIZE}" rx="2" fill="${vocab.square === 'filled' ? cssVar(vocab.token) : 'none'}" stroke="${cssVar('observed')}" stroke-width="1.5" stroke-dasharray="${dashArray(EDGE_VOCABULARY.observed.dash) ?? ''}"/>`;
  const glyphFill = vocab.square === 'filled' ? cssVar('ground') : cssVar(vocab.token);
  return `${square}<text x="${x + MARK_SIZE / 2}" y="${y + MARK_SIZE / 2}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="${glyphFill}">${vocab.glyph}</text>`;
}

/** The provenance line under a marked diagram (issue 512). */
export function describeMarks(m: MutabilityOverlayInput): string {
  if (m.local) {
    const runs = m.sandboxRuns ?? 0;
    return `Read/write marks from ${runs} local sandbox run${runs === 1 ? '' : 's'} on this machine, not from the chain. Not derived from the contract interface.`;
  }
  const range =
    m.firstLedger !== null && m.lastLedger !== null
      ? m.firstLedger === m.lastLedger
        ? ` at ledger ${m.firstLedger}`
        : ` between ledger ${m.firstLedger} and ${m.lastLedger}`
      : '';
  const txs = `${m.transactions} transaction${m.transactions === 1 ? '' : 's'}${range} (RPC keeps about ${m.retentionDays ?? 7} days)`;
  const runs = m.sandboxRuns
    ? `, plus ${m.sandboxRuns} local sandbox run${m.sandboxRuns === 1 ? '' : 's'}`
    : '';
  return `Read/write marks observed from ${txs}${runs}. Not derived from the contract interface.`;
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
  collapsed?: PositionedNode['collapsed'];
  uses?: number;
  hidden?: number;
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
export function nodeKindOf(node: DrawnNode | PositionedNode | DiagramNode): NodeKind {
  const n = node as Partial<DrawnNode>;
  switch (n.kind) {
    case 'function':
      return n.collapsed ? 'collapsed-group' : 'function';
    case 'missing':
    case 'stub':
      return 'stub';
    case 'callee':
    case 'callees-more':
    case 'call-anchor':
      return n.kind;
    case 'type':
      return n.typeKind === 'union' ? 'union' : n.typeKind === 'enum' ? 'enum' : 'struct';
    default:
      return node.id.startsWith('fn:') ? 'function' : 'struct';
  }
}

/** The vocabulary kind a drawn edge is: a call by its evidence, else its first spec kind. */
export function edgeKindOf(edge: DiagramEdge | PositionedEdge): EdgeKind {
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
  const collapsedGroups = nodes.flatMap((n) => (n.collapsed ? [n.collapsed] : []));
  const functionNames = [
    ...functionNodes.map((n) => n.id.slice('fn:'.length)),
    ...collapsedGroups.flatMap((g) => g.members),
  ];
  const allGroups = groupFunctions(functionNames);
  const calls = (model as Partial<PositionedDiagramModel>).calls;
  const callEdges = edges.filter((e) => (e as Partial<PositionedEdge>).call);
  const calleeCount = nodes.filter((n) => n.kind === 'callee').length;

  // A collapsed group (issue 502) counts its members, and as a group.
  const functionCount =
    functionNodes.length + collapsedGroups.reduce((sum, g) => sum + g.members.length, 0);
  let groupPart: string;
  if (allGroups.length === 0) {
    groupPart = `${functionCount} functions, ungrouped`;
  } else if (collapsedGroups.length > 0) {
    groupPart = `${functionCount} functions in ${allGroups.length} groups (${collapsedGroups.length} collapsed)`;
  } else {
    groupPart = `${functionCount} functions in ${allGroups.length} groups`;
  }
  let desc = `${groupPart}, ${typeNodes.length} types, ${model.edges.length - callEdges.length} references`;
  if (calls) {
    desc += `; calls ${calleeCount} other contract${calleeCount === 1 ? '' : 's'}`;
    if (calls.hidden > 0) desc += ` and ${calls.hidden} more`;
  }

  // Canvas: the layout's size, or the drawn nodes' extent plus a margin.
  const extentX = Math.max(0, ...nodes.map((n) => n.x + n.width)) + MARGIN;
  const extentY = Math.max(0, ...nodes.map((n) => n.y + n.height)) + MARGIN;
  const positioned = model as Partial<PositionedDiagramModel>;
  const bodyHeight = Math.ceil(Math.max(positioned.height ?? 0, extentY));

  // The legend and provenance line sit under a call graph or whenever edges are drawn.
  const legendKinds = new Set<EdgeKind | NodeKind>();
  if (edges.length > 0) {
    for (const n of nodes) {
      legendKinds.add(nodeKindOf(n));
    }
    for (const e of edges) {
      if (!(e as Partial<PositionedEdge>).call) {
        legendKinds.add(edgeKindOf(e));
      }
    }
  }
  if (calls) legendKinds.add('callee');
  for (const e of callEdges) {
    legendKinds.add(edgeKindOf(e));
    // A call the chain showed may carry an S too: explain it whenever drawn.
    if ((e as Partial<PositionedEdge>).call!.sandboxRuns > 0) legendKinds.add('call-sandbox');
  }
  if (calls && calls.hidden > 0) legendKinds.add('callees-more');
  if (nodes.some((n) => n.kind === 'call-anchor')) legendKinds.add('call-anchor');
  const provenance = calls ? describeCallWindow(calls) : '';

  const hasLegend = edges.length > 0 || Boolean(calls);

  // Wide enough for the diagram, and for every footer line to be read whole.
  const legendTextWidth = [...legendKinds].map((kind) =>
    kind in NODE_VOCABULARY
      ? textWidth(
          `${NODE_VOCABULARY[kind as NodeKind].prefix} — ${NODE_VOCABULARY[kind as NodeKind].label}`,
          FONT_PX,
        ) + 40
      : textWidth(EDGE_VOCABULARY[kind as EdgeKind].label, FONT_PX) + 40,
  );
  const maxLegendWidth = legendTextWidth.length > 0 ? Math.max(...legendTextWidth) : 0;
  const footerTextWidth = calls
    ? Math.max(textWidth(WEIGHT_NOTE, 12), textWidth(provenance, 12), maxLegendWidth) +
      2 * MARGIN
    : hasLegend
      ? maxLegendWidth + 2 * MARGIN
      : 0;
  // The read/write overlay's key and provenance lines (issue 512).
  const mutability = opts.overlays?.mutability;
  const markLines = mutability
    ? [
        describeMarks(mutability),
        ...(mutability.staleObservations
          ? [
              `${mutability.staleObservations} call${mutability.staleObservations === 1 ? '' : 's'} to an earlier version of this contract not counted.`,
            ]
          : []),
      ]
    : [];
  const markFooter = mutability ? 28 + markLines.length * 20 + 8 : 0;
  const markWidth = mutability
    ? Math.max(...markLines.map((l) => textWidth(l, 12))) + 2 * MARGIN
    : 0;
  const width = Math.ceil(Math.max(positioned.width ?? 0, extentX, footerTextWidth, markWidth));

  const legend = hasLegend
    ? renderLegend(legendKinds, {
        idPrefix: `${idPrefix}legend`,
        width: width - 2 * MARGIN,
      })
    : '';
  const legendHeight = legend ? Number(/data-legend-height="(\d+)"/.exec(legend)![1]) : 0;
  const callFooter = calls ? legendHeight + 3 * 20 + 8 : (hasLegend ? legendHeight : 0);
  const height = bodyHeight + callFooter + markFooter;

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

  const maxUses = Math.max(1, ...nodes.map((n) => n.uses ?? 0));

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
      ? node.id.toLowerCase().includes(cleanQuery) ||
        node.label.toLowerCase().includes(cleanQuery) ||
        (node.collapsed !== undefined &&
          node.collapsed.members.some((m) => m.toLowerCase().includes(cleanQuery)))
      : true;
    // The function's read/write mark (issue 512), for the badge and the detail card.
    const markOf =
      mutability && kind === 'function' ? mutability.marks[node.name ?? node.label] : undefined;
    const markKind = mutability && kind === 'function' ? writeMarkOf(markOf) : null;
    const hasWritingMember =
      node.collapsed !== undefined && mutability !== undefined
        ? node.collapsed.members.some((m) => mutability.marks[m]?.kind === 'writes')
        : false;
    const writesHidden =
      opts.writesOnly && mutability
        ? node.collapsed !== undefined
          ? !hasWritingMember
          : markKind !== 'write'
        : false;
    const hidden = (cleanQuery && !isMatch) || writesHidden;
    const filterClass = hidden ? ' viz-dimmed' : cleanQuery ? ' viz-match' : '';
    const stateClass = focusClass + filterClass;
    const containerClass = stateClass ? ` class="${stateClass.trim()}"` : '';
    let markAttrs = '';
    if (markKind) {
      markAttrs += ` data-mark="${markKind}" data-mark-label="${escapeXml(markText(markOf))}"`;
      if (mutability!.local) markAttrs += ' data-mark-source="local sandbox"';
      const example = markOf?.kind === 'writes' ? markOf.example : undefined;
      if (example?.txHash) {
        markAttrs += ` data-mark-tx="${escapeXml(example.txHash)}" data-mark-ledger="${example.ledger}"`;
        if (mutability!.txHref)
          markAttrs += ` data-mark-href="${escapeXml(mutability!.txHref(example.txHash))}"`;
      }
    } else if (node.collapsed && hasWritingMember) {
      markAttrs += ' data-mark="write"';
    }

    // A collapsed group (issue 502) says which group its link expands.
    if (node.collapsed) {
      markAttrs += ` data-group-toggle="${escapeXml(node.collapsed.group)}" data-members="${escapeXml(node.collapsed.members.join(','))}"`;
    }
    if (node.kind === 'stub' && (node.hidden ?? 0) > 0) {
      markAttrs += ` data-type-toggle="${escapeXml(node.name ?? node.label)}"`;
    }
    const diffKind = opts.diff?.[node.id];
    if (diffKind) markAttrs += ` data-diff="${diffKind}"`;

    if (href) {
      svgParts.push(
        `  <a id="${anchorId}" href="${escapeXml(href)}" data-node-id="${escapeXml(node.id)}"${markAttrs}${containerClass}${autofocusAttr}>`,
      );
    } else {
      svgParts.push(
        `  <g id="${anchorId}" data-node-id="${escapeXml(node.id)}"${markAttrs}${containerClass}${autofocusAttr}>`,
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

    const title = node.collapsed
      ? `${node.name ?? node.label}: ${node.collapsed.members.join(', ')}. Expand to draw them.`
      : (node.name ?? node.label);
    svgParts.push(`    <title>${escapeXml(title)}</title>`);

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

    // Observed use (issue 518): the count right of the label, and a heat bar
    // along the node's foot sized against the busiest function. Zero is the
    // text "0" with no bar.
    if (node.uses !== undefined) {
      const tx = node.x + node.width - MARK_SLOT - 2;
      const bar =
        node.uses > 0
          ? `<rect class="diagram-heat-bar" x="${node.x + 3}" y="${node.y + node.height - 5}" width="${Math.max(1, Math.round(((node.width - 6) * node.uses) / maxUses))}" height="2" fill="${cssVar('accent')}"/>`
          : '';
      svgParts.push(
        `    <g class="diagram-heat" data-uses="${node.uses}"><title>${node.uses} call${node.uses === 1 ? '' : 's'} in the activity range, observed</title><text x="${tx}" y="${node.y + node.height / 2}" text-anchor="end" dominant-baseline="central" font-size="${HEAT_FONT_PX}" fill="${cssVar('muted')}">${node.uses}</text>${bar}</g>`,
      );
    }

    // A spec change (issue 580): a square straddling the top-left corner,
    // + for added and ~ for changed, so it reads without colour.
    if (diffKind) {
      const x = node.x - MARK_SIZE / 2;
      const y = node.y - MARK_SIZE / 2;
      svgParts.push(
        `    <g class="diagram-diff diagram-diff--${diffKind}" data-diff-badge="${diffKind}"><title>${diffKind === 'added' ? 'added' : 'changed'} in this build</title><rect x="${x}" y="${y}" width="${MARK_SIZE}" height="${MARK_SIZE}" rx="2" fill="${cssVar('accent')}"/><text x="${x + MARK_SIZE / 2}" y="${y + MARK_SIZE / 2}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="${cssVar('ground')}">${diffKind === 'added' ? '+' : '~'}</text></g>`,
      );
    }

    if (markKind) {
      const bx = node.x + node.width - 6 - MARK_SIZE;
      const by = node.y + (node.height - MARK_SIZE) / 2;
      svgParts.push(
        `    <g class="diagram-mark diagram-mark--${markKind}"><title>${escapeXml(markText(markOf))}, observed${mutability!.local ? ' in a local sandbox run' : ''}, not from the interface</title>${markBadge(markKind, bx, by)}</g>`,
      );
    }

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
  } else if (hasLegend) {
    svgParts.push(
      `  <g class="diagram-legend-footer" transform="translate(${MARGIN - 8} ${bodyHeight})">`,
    );
    svgParts.push(`    ${legend}`);
    svgParts.push('  </g>');
  }

  if (mutability) {
    // The key and where the marks came from, under everything else.
    const top = bodyHeight + callFooter;
    svgParts.push(`  <g class="diagram-mark-footer" transform="translate(${MARGIN - 8} ${top})">`);
    let x = 8;
    for (const kind of ['write', 'read', 'unknown'] as const) {
      svgParts.push(`    ${markBadge(kind, x, 4)}`);
      const text =
        kind === 'write' ? 'writes' : kind === 'read' ? 'no writes seen' : 'not observed';
      svgParts.push(
        `    <text x="${x + MARK_SIZE + 6}" y="${4 + MARK_SIZE / 2}" dominant-baseline="central" font-size="12" fill="${cssVar('muted')}">${text}</text>`,
      );
      x += MARK_SIZE + 6 + Math.ceil(textWidth(text, 12)) + 18;
    }
    markLines.forEach((line, i) => {
      svgParts.push(
        `    <text class="diagram-mark-provenance" x="8" y="${28 + 12 + i * 20}" font-size="12" fill="${cssVar('muted')}">${escapeXml(line)}</text>`,
      );
    });
    svgParts.push('  </g>');
  }

  svgParts.push('</svg>');

  return svgParts.join('\n');
}

export interface StandaloneSvgOptions {
  theme: VizTheme | 'auto';
  provenance: { address: string; network: string; wasmHash: string };
}

/** The token each `--viz-*` custom property stands for. */
const TOKEN_OF_VARIABLE = new Map<string, VizTokenName>(
  VIZ_TOKEN_NAMES.map((token) => [VIZ_CSS_VARIABLES[token], token] as const),
);

/**
 * Markup from the vocabulary helpers with every `var(--viz-*)` replaced by
 * the token's colour in `theme`. A standalone file has no page to define the
 * custom properties, and not every SVG editor resolves them. Only for markup
 * built here: a name or label from a spec never goes through it.
 */
function withLiteralColours(markup: string, theme: VizTheme): string {
  return markup.replace(/var\((--viz-[a-z-]+)\)/g, (whole, variable: string) => {
    const token = TOKEN_OF_VARIABLE.get(variable);
    return token ? VIZ_TOKENS[theme][token] : whole;
  });
}

/**
 * The dark theme of an `auto` export. Every colour in the file is a literal
 * `fill` or `stroke` attribute in the light theme, so the dark theme is one
 * pair of rules per token, matched on the light colour (`literalColourRules`).
 * Nothing here lists which element takes which token: the vocabulary decides
 * that once.
 */
function darkOverrides(): string {
  return `@media (prefers-color-scheme: dark) { ${literalColourRules('light', 'dark').join(' ')} }`;
}

/** The last footer line of an export that draws no observed call. */
const INTERFACE_ONLY = 'Generated by Signet from the deployed contract interface';

/**
 * The last footer line of an export that draws observed calls: the interface
 * and the calls do not come from the same place, and the file has to say so
 * (design §4.3). Sandbox runs are named when they are where calls were seen.
 */
function callSourceLine(calls: CallSummary): string {
  const sources = [
    ...(calls.transactions > 0 || calls.sandboxRuns === 0 ? ['from indexed transactions'] : []),
    ...(calls.sandboxRuns > 0 ? ['in local sandbox runs'] : []),
  ];
  return `Interface from the deployed contract; calls observed ${sources.join(' and ')}`;
}

/**
 * The self-contained export (issue 506): Download SVG, the PNG made from it,
 * and `signet visualise`.
 *
 * It is drawn in the visual vocabulary the page uses (issue 953): each node
 * in its kind's shape (`nodeShapeSvg`), each edge with its kind's dash and
 * arrowhead (`EDGE_VOCABULARY`), and a call overlay in its observed style,
 * with the count and the sandbox badge. The footer then names the window the
 * calls were observed in and says which part came from where.
 *
 * Colours are literal: each is written as a `fill` or `stroke` attribute, so
 * the file reads in an editor that resolves no custom property and applies
 * no stylesheet. `theme: 'auto'` writes the light theme and overrides it in a
 * `prefers-color-scheme: dark` block, and the root says which theme the
 * attributes are in (`data-export-theme`), for whoever repaints the file, as
 * the PNG export does. No `var()`, no `<script>`, no link and no reference
 * outside the file.
 */
export function renderStandaloneSvg(
  model: PositionedDiagramModel,
  opts: StandaloneSvgOptions,
): string {
  if (!['dark', 'light', 'auto'].includes(opts.theme)) throw new RangeError('Invalid SVG theme');
  const base: VizTheme = opts.theme === 'auto' ? 'light' : opts.theme;
  const colour = (token: VizTokenName) => VIZ_TOKENS[base][token];
  const literal = (markup: string) => withLiteralColours(markup, base);

  const routed = routeEdges(model.nodes, model.edges);
  // The footer speaks of calls only when one is drawn. `visualise()` falls
  // back to a bare function list, which keeps the model's call summary and
  // draws none of its calls.
  const callEdges = routed.filter((edge) => edge.call);
  const calls = callEdges.length > 0 ? model.calls : undefined;
  const footer = [
    `Address: ${opts.provenance.address}`,
    `Network: ${opts.provenance.network}`,
    `WASM hash: ${opts.provenance.wasmHash}`,
    ...(calls ? [describeCallWindow(calls), callSourceLine(calls)] : [INTERFACE_ONLY]),
  ];

  // The legend (issue 952) under the drawing, for the kinds drawn, as on the
  // page: only when an edge is drawn, so the bare function list has none.
  const legendKinds = new Set<DiagramKind>();
  if (routed.length > 0) {
    for (const node of model.nodes) legendKinds.add(nodeKindOf(node));
    for (const edge of routed) legendKinds.add(edgeKindOf(edge));
  }
  const legendWidths = [...legendKinds].map((kind) =>
    kind in NODE_VOCABULARY
      ? textWidth(
          `${NODE_VOCABULARY[kind as NodeKind].prefix} — ${NODE_VOCABULARY[kind as NodeKind].label}`,
          12,
        ) + 40
      : textWidth(EDGE_VOCABULARY[kind as EdgeKind].label, 12) + 40,
  );
  const width = Math.ceil(
    Math.max(
      model.width,
      ...footer.map((line) => textWidth(line, 12) + 48),
      ...legendWidths.map((w) => w + 2 * MARGIN),
    ),
  );
  // Its arrowheads are the drawing's own (`export-*`, defined below for every
  // edge kind drawn, so for every one the legend lists): its defs are dropped.
  const legend =
    legendKinds.size > 0
      ? literal(
          renderLegend(legendKinds, { idPrefix: 'export', width: width - 2 * MARGIN }).replace(
            /<defs>.*?<\/defs>/,
            '',
          ),
        )
      : '';
  const legendHeight = legend ? Number(/data-legend-height="(\d+)"/.exec(legend)![1]) : 0;
  const footerTop = model.height + legendHeight;
  const height = footerTop + 36 + footer.length * 20;

  let counts = `${model.nodes.length} nodes, ${model.edges.length - callEdges.length} references`;
  if (calls) {
    counts += `; calls ${calls.shown} other contract${calls.shown === 1 ? '' : 's'}`;
    if (calls.hidden > 0) counts += ` and ${calls.hidden} more`;
  }

  // A stylesheet rule beats a presentation attribute, so the sizes the count
  // and the badge carry as attributes are repeated here, under `text`.
  const style = [
    'text { font-family: monospace; font-size: 14px; }',
    '.footer, .group-label, .count { font-size: 12px; }',
    '.viz-sandbox-badge text { font-size: 9px; }',
    '.viz-legend-label { font-size: 12px; }',
    ...(opts.theme === 'auto' ? [darkOverrides()] : []),
  ].join('\n');

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="export-title export-desc" data-export-theme="${base}">`,
    `<title id="export-title">${escapeXml(opts.provenance.address)} contract interface</title>`,
    `<desc id="export-desc">${counts}. ${escapeXml(footer.join('. '))}</desc>`,
    `<style>${style}</style>`,
    `<rect class="canvas" width="${width}" height="${height}" fill="${colour('ground')}"/>`,
  ];

  // Arrowheads, one per marker the edges use.
  const usedMarkers = new Set(routed.map((edge) => EDGE_VOCABULARY[edgeKindOf(edge)].marker));
  const markers = (['filled-arrow', 'open-arrow', 'sandbox-arrow'] as const)
    .filter((marker) => usedMarkers.has(marker))
    .map(
      (marker) =>
        `<marker id="export-${marker}" markerWidth="8" markerHeight="8" refX="7.5" refY="3" orient="auto" markerUnits="userSpaceOnUse">${literal(markerGlyph(marker))}</marker>`,
    );
  if (markers.length > 0) parts.push(`<defs>${markers.join('')}</defs>`);

  for (const group of model.groups) {
    parts.push(
      `<rect class="group" x="${group.x}" y="${group.y}" width="${group.width}" height="${group.height}" rx="4" fill="none" stroke="${colour('edge')}"/>`,
    );
    parts.push(
      `<text class="group-label" x="${group.x + 8}" y="${group.y + 16}" fill="${colour('muted')}">${escapeXml(group.name)}</text>`,
    );
  }

  for (const edge of routed) {
    const kind = edgeKindOf(edge);
    const vocab = EDGE_VOCABULARY[kind];
    const dash = dashArray(vocab.dash);
    parts.push(
      `<polyline class="edge" data-edge-kind="${kind}" points="${edge.polyline.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${colour(vocab.token)}" stroke-width="${edgeStrokeWidth(edge, kind)}"${dash ? ` stroke-dasharray="${dash}"` : ''}${vocab.marker === 'none' ? '' : ` marker-end="url(#export-${vocab.marker})"`}/>`,
    );
    if (!edge.call) continue;
    // As on the page: the count rides the last leg, just short of the arrow,
    // and the S badge sits where that leg starts.
    const end = edge.polyline[edge.polyline.length - 1]!;
    const turn = edge.polyline[edge.polyline.length - 2] ?? end;
    parts.push(
      `<text class="count" x="${end.x - 12}" y="${end.y - 3}" text-anchor="end" fill="${colour('muted')}" stroke="${colour('ground')}" stroke-width="3" paint-order="stroke">×${edge.call.count}</text>`,
    );
    if (edge.call.sandboxRuns > 0) parts.push(literal(sandboxBadge(turn.x, turn.y)));
  }

  for (const node of model.nodes) {
    const kind = nodeKindOf(node);
    const quiet = kind === 'call-anchor' || kind === 'callees-more' || kind === 'stub';
    // A callee is ringed in the observed colour, as its edges are.
    const shape = nodeShapeSvg(
      NODE_VOCABULARY[kind].shape,
      node.x,
      node.y,
      node.width,
      node.height,
      { className: 'node', ...(kind === 'callee' && { stroke: 'observed' as const }) },
    );
    parts.push(
      `<g data-node-kind="${kind}"><title>${escapeXml(node.name)}</title>${literal(shape)}`,
    );
    parts.push(
      `<text class="label" x="${node.x + 10}" y="${node.y + node.height / 2 + 5}" fill="${colour(quiet ? 'muted' : 'nodeText')}">${escapeXml(node.label)}</text></g>`,
    );
  }

  if (legend) {
    parts.push(`<g class="export-legend" transform="translate(${MARGIN - 8} ${model.height})">${legend}</g>`);
  }

  footer.forEach((line, index) =>
    parts.push(
      `<text class="footer" x="24" y="${footerTop + 28 + index * 20}" fill="${colour('muted')}">${escapeXml(line)}</text>`,
    ),
  );
  parts.push('</svg>');
  return parts.join('\n');
}
