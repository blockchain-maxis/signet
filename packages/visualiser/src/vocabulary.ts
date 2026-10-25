/**
 * @file Visual vocabulary table (#493, backlog E-13, design §2.3).
 *
 * "Never hue alone." Every distinction the diagram makes has to survive
 * greyscale, colour-blindness and a theme that drops the accent, so each one is
 * carried by a shape or stroke pattern *and* a text or glyph cue as well as a
 * colour token. This module fixes that vocabulary in one place — node shapes
 * and prefixes, edge dash/marker styles, and the reserved phase-2 write marks —
 * so the renderer, the overlays and the legend never invent their own.
 *
 * The tables here are pure data; {@link renderLegend} turns the subset a
 * diagram actually draws into an SVG `<g>` any renderer can drop in. The
 * colours are referenced only through `--viz-*` custom properties (see
 * `tokens.ts`), so this module names no hex value and the legend re-themes with
 * the rest of the diagram.
 *
 * Uniqueness contract (asserted in `vocabulary.test.ts`):
 * - no two node kinds share both a shape and a text prefix, and
 * - no two edge kinds share both a dash pattern and a marker.
 */

import { VIZ_CSS_VARIABLES, type VizTokenName } from './tokens.ts';

/**
 * The node kinds the diagram distinguishes. The last three belong to the
 * phase-3 call graph (#543): another contract this one called, the collapsed
 * "+K other contracts", and the anchor for calls whose function is unknown.
 */
export type NodeKind =
  | 'function'
  | 'collapsed-group'
  | 'struct'
  | 'union'
  | 'enum'
  | 'stub'
  | 'callee'
  | 'callees-more'
  | 'call-anchor';

/**
 * The outline a node is drawn with. `stub` is always a dashed outline, so a
 * link out to the docs reads differently from a fully drawn node even in
 * greyscale.
 */
export type NodeShape = 'rect' | 'rounded-rect' | 'notched-rect' | 'dashed-outline-rect';

/** The text token printed before a node's name, e.g. `fn transfer`. */
export type NodePrefix =
  'fn' | 'group' | 'struct' | 'union' | 'enum' | 'stub' | 'contract' | 'more' | 'anchor';

/** One node kind's fixed visual treatment. */
export interface NodeVocabulary {
  readonly shape: NodeShape;
  readonly prefix: NodePrefix;
  /** The `--viz-*` token that fills the node. */
  readonly token: VizTokenName;
  /** Human-readable name for the legend. */
  readonly label: string;
}

/**
 * The edge kinds the diagram distinguishes. The `call-*` kinds are the
 * phase-3 call graph (#543), one per kind of evidence for the call, weakest
 * last: an auth tree names caller, callee and function; an event shows the
 * callee ran; a footprint only that it was touched; a sandbox trace is a
 * local run of the call.
 */
export type EdgeKind =
  | 'arg'
  | 'return'
  | 'field'
  | 'observed'
  | 'observed-write'
  | 'call-auth-tree'
  | 'call-event'
  | 'call-footprint'
  | 'call-sandbox';

/**
 * Solid for spec-derived edges; the observed overlays use the others. A
 * sandbox call is solid too, and tells itself apart by its `S` marker.
 */
export type DashPattern = 'solid' | 'dashed' | 'long-dash' | 'dash-dot' | 'dotted';

/**
 * The stroke end-cap. A filled arrow for arguments, an open one for returns,
 * none for fields. `none` and the two arrow shapes stay readable without hue.
 */
export type EdgeMarker = 'none' | 'open-arrow' | 'filled-arrow' | 'sandbox-arrow';

/** One edge kind's fixed visual treatment. */
export interface EdgeVocabulary {
  readonly dash: DashPattern;
  readonly marker: EdgeMarker;
  /** `thin` is the field line; arguments and returns are `normal`. */
  readonly strokeWidth: 'thin' | 'normal';
  /** The `--viz-*` token that strokes the edge. */
  readonly token: VizTokenName;
  /** True for edges derived from the spec, false for observed overlays. */
  readonly specDerived: boolean;
  /**
   * Whether the edge must carry a text label. The spec-derived / observed
   * distinction is always dash pattern *plus* label, never colour alone.
   */
  readonly requiresLabel: boolean;
  /** Human-readable name for the legend. */
  readonly label: string;
}

/** The phase-2 write marks, reserved here so overlays only fill them in. */
export type WriteMark = 'write' | 'read' | 'unknown';

/** One write mark's fixed glyph and square treatment. */
export interface WriteMarkVocabulary {
  /** The single glyph drawn inside the square. */
  readonly glyph: 'W' | 'R' | '?';
  /** A filled square is an observed write, an outline one is no writes seen. */
  readonly square: 'filled' | 'outline' | 'none';
  readonly token: VizTokenName;
  readonly label: string;
}

/**
 * Node kind → shape / prefix / token. The shape is chosen so the four fully
 * drawn kinds read apart in greyscale: functions are rounded, structs plain,
 * unions notched, enums plain but always prefixed `enum`. Stubs are the one
 * dashed outline and share no shape with a drawn kind.
 */
export const NODE_VOCABULARY: Record<NodeKind, NodeVocabulary> = {
  function: {
    shape: 'rounded-rect',
    prefix: 'fn',
    token: 'accent',
    label: 'function',
  },
  // A collapsed function group (#502): a dashed outline, since it links to
  // the URL that expands it, as a stub links out to the docs.
  'collapsed-group': {
    shape: 'dashed-outline-rect',
    prefix: 'group',
    token: 'accent',
    label: 'collapsed function group (expands)',
  },
  struct: {
    shape: 'rect',
    prefix: 'struct',
    token: 'node',
    label: 'struct',
  },
  union: {
    shape: 'notched-rect',
    prefix: 'union',
    token: 'node',
    label: 'union',
  },
  enum: {
    shape: 'rect',
    prefix: 'enum',
    token: 'node',
    label: 'enum',
  },
  stub: {
    shape: 'dashed-outline-rect',
    prefix: 'stub',
    token: 'muted',
    label: 'stub (links to docs)',
  },
  callee: {
    shape: 'rect',
    prefix: 'contract',
    token: 'observed',
    label: 'contract this one calls',
  },
  'callees-more': {
    shape: 'dashed-outline-rect',
    prefix: 'more',
    token: 'muted',
    label: 'more contracts (expands)',
  },
  'call-anchor': {
    shape: 'notched-rect',
    prefix: 'anchor',
    token: 'muted',
    label: 'this contract, calling function unknown',
  },
};

/**
 * Edge kind → dash / marker / token. Argument and return edges are both solid,
 * so their arrowheads differ: a filled arrow for an argument, an open one for a
 * return. Fields are thin and unmarked. Observed edges are dashed and labelled.
 */
export const EDGE_VOCABULARY: Record<EdgeKind, EdgeVocabulary> = {
  arg: {
    dash: 'solid',
    marker: 'filled-arrow',
    strokeWidth: 'normal',
    token: 'edge',
    specDerived: true,
    requiresLabel: false,
    label: 'argument (solid, filled arrow)',
  },
  return: {
    dash: 'solid',
    marker: 'open-arrow',
    strokeWidth: 'normal',
    token: 'edge',
    specDerived: true,
    requiresLabel: false,
    label: 'return (solid, open arrow)',
  },
  field: {
    dash: 'solid',
    marker: 'none',
    strokeWidth: 'thin',
    token: 'edge',
    specDerived: true,
    requiresLabel: false,
    label: 'field (thin solid)',
  },
  observed: {
    dash: 'dashed',
    marker: 'open-arrow',
    strokeWidth: 'normal',
    token: 'observed',
    specDerived: false,
    requiresLabel: true,
    label: 'observed (dashed, labelled)',
  },
  // The storage view (#515): a function seen changing a slot. Reads there
  // are plain `observed` edges, so the arrowhead alone tells them apart.
  'observed-write': {
    dash: 'dashed',
    marker: 'filled-arrow',
    strokeWidth: 'normal',
    token: 'observed',
    specDerived: false,
    requiresLabel: true,
    label: 'observed write (dashed, filled arrow)',
  },
  'call-auth-tree': {
    dash: 'long-dash',
    marker: 'filled-arrow',
    strokeWidth: 'normal',
    token: 'observed',
    specDerived: false,
    requiresLabel: true,
    label: 'call, named by an auth tree (long dash)',
  },
  'call-event': {
    dash: 'dash-dot',
    marker: 'filled-arrow',
    strokeWidth: 'normal',
    token: 'observed',
    specDerived: false,
    requiresLabel: true,
    label: 'call, the callee emitted an event (dash-dot)',
  },
  'call-footprint': {
    dash: 'dotted',
    marker: 'filled-arrow',
    strokeWidth: 'normal',
    token: 'observed',
    specDerived: false,
    requiresLabel: true,
    label: 'call, the callee was in the footprint (dotted)',
  },
  'call-sandbox': {
    dash: 'solid',
    marker: 'sandbox-arrow',
    strokeWidth: 'normal',
    token: 'observed',
    specDerived: false,
    requiresLabel: true,
    label: 'call, seen in a local sandbox run (solid, S)',
  },
};

/** Write mark → glyph / square / token. Reserved for the phase-2 overlay. */
export const WRITE_MARK_VOCABULARY: Record<WriteMark, WriteMarkVocabulary> = {
  write: {
    glyph: 'W',
    square: 'filled',
    token: 'write',
    label: 'observed write',
  },
  read: {
    glyph: 'R',
    square: 'outline',
    token: 'read',
    label: 'no writes seen',
  },
  unknown: {
    glyph: '?',
    square: 'none',
    token: 'muted',
    label: 'unknown',
  },
};

/** Canonical render order, so the legend is deterministic whatever is passed. */
export const NODE_KIND_ORDER: readonly NodeKind[] = [
  'function',
  'collapsed-group',
  'struct',
  'union',
  'enum',
  'stub',
  'callee',
  'callees-more',
  'call-anchor',
];

export const EDGE_KIND_ORDER: readonly EdgeKind[] = [
  'arg',
  'return',
  'field',
  'observed',
  'observed-write',
  'call-auth-tree',
  'call-event',
  'call-footprint',
  'call-sandbox',
];

export const WRITE_MARK_ORDER: readonly WriteMark[] = ['write', 'read', 'unknown'];

/** Any kind the legend can describe. */
export type DiagramKind = NodeKind | EdgeKind | WriteMark;

const NODE_KINDS = new Set<string>(NODE_KIND_ORDER);
const EDGE_KINDS = new Set<string>(EDGE_KIND_ORDER);
const WRITE_MARKS = new Set<string>(WRITE_MARK_ORDER);

/** The node vocabulary for a decoded `SpecType['kind']`. */
export function nodeVocabulary(kind: NodeKind): NodeVocabulary {
  return NODE_VOCABULARY[kind];
}

/** The edge vocabulary for an edge kind. */
export function edgeVocabulary(kind: EdgeKind): EdgeVocabulary {
  return EDGE_VOCABULARY[kind];
}

/** `cssVar('node')` → `var(--viz-node)`. */
function cssVar(token: VizTokenName): string {
  return `var(${VIZ_CSS_VARIABLES[token]})`;
}

/** Escapes a string for XML text or attribute content. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Dash array per pattern; `undefined` keeps the stroke solid. */
export function dashArray(dash: DashPattern): string | undefined {
  switch (dash) {
    case 'dashed':
      return '5 3';
    case 'long-dash':
      return '10 4';
    case 'dash-dot':
      return '8 3 1.5 3';
    case 'dotted':
      return '1.5 3';
    default:
      return undefined;
  }
}

/** Stroke width in user units. */
function strokeWidth(width: EdgeVocabulary['strokeWidth']): number {
  return width === 'thin' ? 1 : 1.75;
}

/**
 * The SVG element for a node swatch of shape `shape` at `(x, y)`, `w`×`h`.
 * Rectangles use `<rect>`; the notched shape uses a `<path>` with the
 * top-right corner cut, which stays legible when the fill and stroke are the
 * same grey. Carries `data-node-shape` for tests and tooling.
 */
export function nodeShapeSvg(
  shape: NodeShape,
  x: number,
  y: number,
  w: number,
  h: number,
  attrs: NodeShapeAttrs = {},
): string {
  const fill = shape === 'dashed-outline-rect' ? 'none' : cssVar('node');
  const id = attrs.id ? `id="${escapeXml(attrs.id)}" ` : '';
  const extraClass = attrs.className ? ` ${escapeXml(attrs.className)}` : '';
  const stroke = attrs.stroke
    ? `stroke="${cssVar(attrs.stroke)}" stroke-width="1.5"`
    : `stroke="${cssVar('edge')}"`;
  const common = `data-node-shape="${shape}" fill="${fill}" ${stroke}`;
  if (shape === 'notched-rect') {
    const notch = Math.min(7, w / 3, h / 3);
    const d = `M ${x} ${y} H ${x + w - notch} L ${x + w} ${y + notch} V ${y + h} H ${x} Z`;
    return `<path ${id}class="viz-shape viz-shape--notched${extraClass}" ${common} d="${d}"/>`;
  }
  const radius = shape === 'rounded-rect' ? 6 : 0;
  const dash = shape === 'dashed-outline-rect' ? ` stroke-dasharray="5 3"` : '';
  return `<rect ${id}class="viz-shape viz-shape--${shape}${extraClass}" ${common} x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ry="${radius}"${dash}/>`;
}

/** Optional extras on a node outline: its id, classes, and a stroke token. */
export interface NodeShapeAttrs {
  readonly id?: string;
  readonly className?: string;
  /** Ring the outline in this token, a little heavier, instead of the edge colour. */
  readonly stroke?: VizTokenName;
}

/**
 * Arrow marker `<path>` data per marker kind, as an SVG fragment. The
 * sandbox arrow is a filled arrow in the observed colour; the `S` that tells
 * it apart is drawn on the edge itself (and on the legend swatch), since a
 * marker scales with the stroke and a letter inside one would not stay
 * legible.
 */
export function markerGlyph(marker: EdgeMarker): string {
  if (marker === 'sandbox-arrow') {
    return `<path class="viz-arrow viz-arrow--sandbox" d="M0,0 L8,3 L0,6 Z" fill="${cssVar('observed')}"/>`;
  }
  if (marker === 'open-arrow') {
    return `<path class="viz-arrow viz-arrow--open" d="M0,0 L8,3 L0,6" fill="none" stroke="${cssVar('edge')}" stroke-width="1.25"/>`;
  }
  if (marker === 'filled-arrow') {
    return `<path class="viz-arrow viz-arrow--filled" d="M0,0 L8,3 L0,6 Z" fill="${cssVar('edge')}"/>`;
  }
  return '';
}

/** Marker id used by both the legend defs and its edge swatches. */
export function markerId(idPrefix: string, marker: EdgeMarker): string {
  return marker === 'none' ? '' : `${idPrefix}-${marker}`;
}

/**
 * The `S` badge a sandbox call edge carries at `(x, y)`: a ground-filled
 * disc ringed in the observed colour, so the letter reads over the line.
 */
export function sandboxBadge(x: number, y: number): string {
  return `<g class="viz-sandbox-badge" data-sandbox-badge=""><circle cx="${x}" cy="${y}" r="6" fill="${cssVar('ground')}" stroke="${cssVar('observed')}" stroke-width="1.25"/><text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="600" fill="${cssVar('observed')}">S</text></g>`;
}

/** Options for {@link renderLegend}. */
export interface LegendOptions {
  /**
   * Prefix for marker element ids, so several legends on one page do not
   * collide. Defaults to `viz-legend`.
   */
  readonly idPrefix?: string;
  /** Left/right padding of the legend box. Default 8. */
  readonly padding?: number;
  /** Height of one legend row. Default 24. */
  readonly rowHeight?: number;
  /** Width of the legend box. Default 260. */
  readonly width?: number;
}

const LEGEND_DEFAULTS = {
  idPrefix: 'viz-legend',
  padding: 8,
  rowHeight: 24,
  width: 260,
} as const;

/**
 * Renders a legend `<g>` for exactly the kinds the caller passes. Each row is
 * a swatch drawn with the fixed vocabulary plus its text label; the write marks
 * only appear when a phase-2 overlay passes them. Colour comes from `--viz-*`
 * custom properties, so the same markup reads in greyscale.
 *
 * The input is any iterable of {@link DiagramKind}; unknown strings are
 * ignored and duplicates collapse. Rows follow the canonical vocabulary order,
 * so the output is deterministic regardless of input order.
 */
export function renderLegend(
  kindsPresent: Iterable<DiagramKind>,
  options: LegendOptions = {},
): string {
  const idPrefix = options.idPrefix ?? LEGEND_DEFAULTS.idPrefix;
  const padding = options.padding ?? LEGEND_DEFAULTS.padding;
  const rowHeight = options.rowHeight ?? LEGEND_DEFAULTS.rowHeight;
  const width = options.width ?? LEGEND_DEFAULTS.width;

  const present = new Set<string>(kindsPresent);
  const nodeKinds = NODE_KIND_ORDER.filter((kind) => present.has(kind));
  const edgeKinds = EDGE_KIND_ORDER.filter((kind) => present.has(kind));
  const writeMarks = WRITE_MARK_ORDER.filter((kind) => present.has(kind));

  const rows: string[] = [];
  let row = 0;

  for (const kind of nodeKinds) {
    const vocab = NODE_VOCABULARY[kind];
    const y = padding + row * rowHeight;
    row += 1;
    rows.push(
      nodeShapeSvg(
        vocab.shape,
        padding,
        y + 5,
        22,
        14,
        vocab.token === 'observed' ? { stroke: 'observed' } : {},
      ),
    );
    rows.push(
      `<text class="viz-legend-label" fill="${cssVar('muted')}" data-node-kind="${kind}" data-node-prefix="${vocab.prefix}" x="${padding + 32}" y="${y + 12}" dominant-baseline="middle">${escapeXml(`${vocab.prefix} — ${vocab.label}`)}</text>`,
    );
  }

  for (const kind of edgeKinds) {
    const vocab = EDGE_VOCABULARY[kind];
    const y = padding + row * rowHeight;
    row += 1;
    const x1 = padding;
    const x2 = padding + 22;
    const dash = dashArray(vocab.dash);
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
    const marker = markerId(idPrefix, vocab.marker);
    const markerAttr = marker ? ` marker-end="url(#${marker})"` : '';
    rows.push(
      `<line class="viz-edge-swatch" data-edge-kind="${kind}" data-edge-dash="${vocab.dash}" data-edge-marker="${vocab.marker}" x1="${x1}" y1="${y + 12}" x2="${x2}" y2="${y + 12}" stroke="${cssVar(vocab.token)}" stroke-width="${strokeWidth(vocab.strokeWidth)}"${dashAttr}${markerAttr}/>`,
    );
    if (vocab.marker === 'sandbox-arrow') rows.push(sandboxBadge((x1 + x2) / 2, y + 12));
    rows.push(
      `<text class="viz-legend-label" fill="${cssVar('muted')}" data-edge-label="${kind}" x="${padding + 32}" y="${y + 12}" dominant-baseline="middle">${escapeXml(vocab.label)}</text>`,
    );
  }

  for (const kind of writeMarks) {
    const vocab = WRITE_MARK_VOCABULARY[kind];
    const y = padding + row * rowHeight;
    row += 1;
    const glyphFill =
      vocab.square === 'filled'
        ? cssVar('ground')
        : vocab.square === 'outline'
          ? cssVar(vocab.token)
          : 'currentColor';
    if (vocab.square === 'filled') {
      rows.push(
        `<rect class="viz-mark-square" data-write-square="filled" x="${padding}" y="${y + 5}" width="14" height="14" fill="${cssVar(vocab.token)}" stroke="${cssVar(vocab.token)}" stroke-width="1.5"/>`,
      );
    } else if (vocab.square === 'outline') {
      rows.push(
        `<rect class="viz-mark-square" data-write-square="outline" x="${padding}" y="${y + 5}" width="14" height="14" fill="none" stroke="${cssVar(vocab.token)}" stroke-width="1.5"/>`,
      );
    }
    rows.push(
      `<text class="viz-mark-glyph" data-write-mark="${kind}" data-write-square="${vocab.square}" data-write-glyph="${vocab.glyph}" x="${padding + 7}" y="${y + 12}" text-anchor="middle" dominant-baseline="middle" fill="${glyphFill}">${vocab.glyph}</text>`,
    );
    rows.push(
      `<text class="viz-legend-label" fill="${cssVar('muted')}" data-write-label="${kind}" x="${padding + 32}" y="${y + 12}" dominant-baseline="middle">${escapeXml(vocab.label)}</text>`,
    );
  }

  // Only emit marker defs for markers actually used, so a nodes-only legend
  // carries no dead defs.
  const usedMarkers = new Set(edgeKinds.map((kind) => EDGE_VOCABULARY[kind].marker));
  const defs: string[] = [];
  for (const marker of ['open-arrow', 'filled-arrow', 'sandbox-arrow'] as const) {
    if (!usedMarkers.has(marker)) continue;
    defs.push(
      `<marker id="${markerId(idPrefix, marker)}" markerWidth="8" markerHeight="8" refX="7.5" refY="3" orient="auto" markerUnits="strokeWidth">${markerGlyph(marker)}</marker>`,
    );
  }
  const defsBlock = defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '';

  const rowCount = nodeKinds.length + edgeKinds.length + writeMarks.length;
  const height = padding * 2 + rowCount * rowHeight;

  return `<g class="viz-legend" role="group" aria-label="Diagram legend" data-viz-legend="" data-legend-width="${width}" data-legend-height="${height}"><title>Diagram legend</title>${defsBlock}${rows.join('')}</g>`;
}
