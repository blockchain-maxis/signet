/**
 * @file Layered column layout engine (#486, design §2.1 and §4.2).
 *
 * `layoutContractGraph` turns the abstract graph (E-02, `graph.ts`) into a
 * positioned diagram model: every node has an `x`, `y`, `width` and `height`,
 * every edge says whether it runs backwards, and function groups (E-04) come
 * out as boxes. It is the pass between the graph and `routeEdges` (E-07).
 *
 * Why hand-rolled columns, and not elkjs or a force-directed layout
 * (design §2.1):
 *
 * - A force-directed layout is non-deterministic and needs a client-side
 *   engine, and the diagram must be the same bytes for the same `wasmHash`
 *   everywhere it is drawn.
 * - elkjs only has an async API (`elk.layout()` returns a Promise). That clashes
 *   with synchronous server rendering and with the Go CLI's embedded JS engine
 *   (#544), and it adds about 1.4 MB to solve general graph layout.
 * - This graph is not a general graph. It is shallow and mostly directed with a
 *   known root: functions on the left, the types they reach to the right. Rank
 *   assignment is therefore known up front, and a small column layout with
 *   barycentre ordering is enough, easy to review and deterministic by
 *   construction. `layoutContractGraph` is the swap point if a later contract
 *   needs more.
 *
 * The result is a pure function of its inputs. No clock, no randomness, no
 * DOM, no measuring: widths come from `metrics.ts`. Every ordering is derived
 * from graph order and then sorted with an explicit tie-break on node id, and
 * all coordinates are integers.
 *
 * ## Ranks
 *
 * Functions are rank 0 (column 0). Cycles in the type graph (recursive types,
 * a type reaching itself) are broken first: a depth-first walk in graph order
 * marks every edge that closes a cycle as `back`. Over the remaining acyclic
 * graph a type's rank is the longest path from a function, so every edge that
 * is not `back` runs strictly left to right. That is the same rank as "one more
 * than the shortest distance" whenever no edge joins two types at the same
 * depth, and it is what stops such an edge from landing inside one column,
 * where the router could only draw it as a back edge. A type nothing points at
 * is placed in column 1.
 *
 * ## Ordering
 *
 * Column 0 keeps the group order from `groupFunctions` (largest first), and
 * the spec order inside each group, so a group's functions stay contiguous and
 * match the docs. Every later column is ordered by four barycentre sweeps
 * (right, left, right, left) with ties broken by node id.
 *
 * ## Callees (#543)
 *
 * The phase-3 call graph is an overlay, not part of the spec's graph: given
 * one, the contracts this one called form the right-most column, heaviest
 * first, ties by address. Past `MAX_CALLEES` the rest collapse into one
 * "+K other contracts" node unless the caller expands them. A call whose
 * function is unknown starts from a "contract (function unknown)" anchor at
 * the top of column 0. Each call edge carries its count, its evidence, and a
 * stroke weight of 1, 2 or 3 by the tercile of its count.
 */

import type { SpecType } from '@signet/spec';
import { groupFunctions, type FunctionGroup } from './group.ts';
import type { ContractGraph, GraphEdge, GraphEdgeKind, GraphNode } from './graph.ts';
import type { DiagramModel } from './index.ts';
import { MIN_TEXT_PX, textWidth, truncateLabel } from './metrics.ts';
import type { RoutableEdge, RoutableNode } from './route.ts';
import type { CallEvidence } from './observe/calls.ts';
import type { CallGraphOverlay } from './observe/call-graph.ts';

/** Callees drawn before the rest collapse into "+K other contracts" (#543). */
export const MAX_CALLEES = 12;

/** Node ids of the call-graph overlay. */
export const CALL_ANCHOR_ID = 'call:anchor';
export const CALLEES_MORE_ID = 'callees:more';
export function calleeNodeId(address: string): string {
  return `callee:${address}`;
}

/**
 * Bumped on any change to the algorithm or its defaults, so a cache keyed on
 * `wasmHash` (#497) can tell a stale layout from a current one.
 */
export const LAYOUT_VERSION = 2;

/**
 * The room every function node keeps at its right end for its read/write
 * mark (#512): the reserved glyphs of #493, filled in by the overlay. Kept
 * whether or not an overlay is drawn, so the cached layout never depends on
 * the overlay (design §4.2). Version 2 of the layout added it.
 */
export const MARK_SLOT = 22;

/**
 * Maximum number of raw nodes `layoutContractGraph` will lay out (#507).
 * Above this ceiling it returns a `too-large` model immediately without
 * running cycle detection, rank assignment, or barycentre sweeps.
 */
export const MAX_RAW_NODES = 500;

/** Barycentre sweeps over the columns after the first (design: 4, alternating). */
const SWEEPS = 4;

/**
 * Room reserved for the lanes `routeEdges` runs back edges along: a first lane
 * `BACK_LANE_BASE` above the top and one more every `BACK_LANE_STEP`, and a
 * back edge leaves the last column, or enters the first, `BACK_LANE_BASE` to
 * the side. These mirror the router's `outsidePadding` and `channelGap`
 * defaults; the routed-bounds tests fail if they drift apart.
 */
const BACK_LANE_BASE = 16;
const BACK_LANE_STEP = 8;

/** Geometry of the layout. Every field is optional; the defaults are below. */
export interface LayoutGeometryOptions {
  /** Label size in CSS pixels. At least `MIN_TEXT_PX`; default 14. */
  fontSizePx?: number;
  /** Space between a node's edge and its label, each side. Default 10. */
  nodePaddingX?: number;
  /** Widest a node gets; a longer label is truncated with `…`. Default 240. */
  maxNodeWidth?: number;
  /** Space between columns, where edges turn. Default 96. */
  columnGutter?: number;
  /** Space between stacked nodes. Default 12. */
  rowGap?: number;
  /** Space between two group boxes. Default 20. */
  groupGap?: number;
  /** Space between a group box and the nodes inside it. Default 8. */
  groupPadding?: number;
  /**
   * Space around the whole diagram. At least `groupPadding`. Default 24. When
   * the graph has back edges the left and right space is raised to the
   * router's 16px, so their routes stay on the canvas.
   */
  margin?: number;
}

/** The overlays a layout can carry besides the spec's graph. */
export interface LayoutOverlays {
  /** The call graph (#543): callees, in the right-most column. */
  calls?: {
    overlay: CallGraphOverlay;
    /** Plain-language callee labels by address (#517); the short address otherwise. */
    labels?: ReadonlyMap<string, string>;
    /** Draw every callee instead of collapsing past `MAX_CALLEES`. */
    expand?: boolean;
  };
}

/** A call edge's weight and evidence (#543). */
export interface PositionedCall {
  /** Transactions plus sandbox runs that made the call. */
  count: number;
  /** The strongest chain evidence; null when only sandbox runs saw it. */
  evidence: CallEvidence | null;
  sandboxRuns: number;
  /** Stroke weight by the tercile of `count` among the drawn call edges. */
  weight: 1 | 2 | 3;
}

/** What the call graph a diagram draws was observed over (#543). */
export interface CallSummary {
  transactions: number;
  firstLedger: number | null;
  lastLedger: number | null;
  sandboxRuns: number;
  /** Callees drawn, and callees collapsed into "+K other contracts". */
  shown: number;
  hidden: number;
}

/** The node kinds of the call-graph overlay. */
export type CallNodeKind = 'callee' | 'callees-more' | 'call-anchor';

/** A node with a position. Columns share an `x`, which `routeEdges` relies on. */
export interface PositionedNode extends RoutableNode {
  kind: GraphNode['kind'] | CallNodeKind;
  /** The full name. `label` is truncated to fit `maxNodeWidth`. */
  name: string;
  /** True when `label` is shorter than `name`. */
  truncated: boolean;
  /** 0 holds the functions; type nodes start at 1. */
  column: number;
  /** The kind of a user-defined type; absent for functions and missing types. */
  typeKind?: SpecType['kind'];
  /** The group box a function sits in, when the contract is grouped. */
  groupId?: string;
  /** A callee's contract address. */
  address?: string;
  /** For "+K other contracts": the addresses it stands for. */
  hiddenAddresses?: string[];
  /** For a collapsed function group (#502): the group, and the functions it stands for. */
  collapsed?: { group: string; members: string[] };
}

export interface PositionedEdge extends RoutableEdge {
  /** `<from>-><to>`, as in the graph. */
  id: string;
  kinds: readonly (GraphEdgeKind | 'call')[];
  /** True for the edge that closes a cycle: it runs right to left or loops. */
  back: boolean;
  /** Set on a call edge of the call-graph overlay. */
  call?: PositionedCall;
}

/** The box drawn around one function group. */
export interface PositionedGroup {
  /** `group:<name>`. */
  id: string;
  name: string;
  kind: FunctionGroup['kind'];
  /** Member function node ids, top to bottom. */
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the renderer and the router consume. A `DiagramModel` with geometry. */
export interface PositionedDiagramModel extends DiagramModel {
  layoutVersion: number;
  /** Set to `'too-large'` when `graph.nodes.length > MAX_RAW_NODES` (#507). */
  status?: 'too-large';
  /** True when the raw-node guard refused to lay out the graph (#507). */
  tooLarge?: boolean;
  /** Raw node count when refused by the raw-node guard (#507). */
  rawNodeCount?: number;
  width: number;
  height: number;
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  /** Empty when the contract is not grouped. */
  groups: PositionedGroup[];
  /** Present when a call graph overlay drew at least one callee. */
  calls?: CallSummary;
}

interface Geometry {
  fontSizePx: number;
  nodePaddingX: number;
  maxNodeWidth: number;
  columnGutter: number;
  rowGap: number;
  groupGap: number;
  groupPadding: number;
  margin: number;
  nodeHeight: number;
  groupHeaderHeight: number;
}

function resolveGeometry(opts: LayoutGeometryOptions): Geometry {
  const fontSizePx = opts.fontSizePx ?? 14;
  if (!Number.isFinite(fontSizePx) || fontSizePx < MIN_TEXT_PX) {
    throw new RangeError(`fontSizePx must be a number of at least ${MIN_TEXT_PX}`);
  }
  const nonNegative = (value: number | undefined, fallback: number, name: string): number => {
    const result = value ?? fallback;
    if (!Number.isFinite(result) || result < 0) {
      throw new RangeError(`${name} must be a non-negative number`);
    }
    return result;
  };
  const nodePaddingX = nonNegative(opts.nodePaddingX, 10, 'nodePaddingX');
  const maxNodeWidth = nonNegative(opts.maxNodeWidth, 240, 'maxNodeWidth');
  const groupPadding = nonNegative(opts.groupPadding, 8, 'groupPadding');
  const margin = nonNegative(opts.margin, 24, 'margin');
  if (maxNodeWidth - 2 * nodePaddingX < textWidth('x', fontSizePx)) {
    throw new RangeError('maxNodeWidth leaves no room for a single character of label');
  }
  if (margin < groupPadding) {
    throw new RangeError('margin must be at least groupPadding, so group boxes stay on the canvas');
  }
  const nodeHeight = Math.round(fontSizePx * 2);
  return {
    fontSizePx,
    nodePaddingX,
    maxNodeWidth,
    columnGutter: nonNegative(opts.columnGutter, 96, 'columnGutter'),
    rowGap: nonNegative(opts.rowGap, 12, 'rowGap'),
    groupGap: nonNegative(opts.groupGap, 20, 'groupGap'),
    groupPadding,
    margin,
    nodeHeight,
    groupHeaderHeight: nodeHeight,
  };
}

/** Code-unit string order: locale-independent, so output is deterministic. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

interface OutEdge {
  edge: GraphEdge;
  index: number;
}

/**
 * Indexes of the edges that close a cycle, found by a depth-first walk in
 * graph order. An edge into a function is also reported: nothing sits left of
 * column 0, so it can only run backwards.
 */
function findBackEdges(
  order: readonly string[],
  out: ReadonlyMap<string, OutEdge[]>,
  kindOf: ReadonlyMap<string, GraphNode['kind']>,
): Set<number> {
  const back = new Set<number>();
  const state = new Map<string, 1 | 2>(); // 1 = on the walk's stack, 2 = finished

  for (const root of order) {
    if (state.has(root)) continue;
    state.set(root, 1);
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const edges = out.get(top.id) ?? [];
      if (top.next >= edges.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const { edge, index } = edges[top.next++]!;
      if (kindOf.get(edge.to) === 'function' || state.get(edge.to) === 1) {
        back.add(index);
      } else if (!state.has(edge.to)) {
        state.set(edge.to, 1);
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }
  return back;
}

/**
 * Longest-path ranks over the acyclic remainder. Functions are rank 0, and a
 * type is at least rank 1 even when nothing reaches it.
 */
function assignRanks(
  order: readonly string[],
  out: ReadonlyMap<string, OutEdge[]>,
  kindOf: ReadonlyMap<string, GraphNode['kind']>,
  back: ReadonlySet<number>,
): Map<string, number> {
  const rank = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const id of order) {
    rank.set(id, kindOf.get(id) === 'function' ? 0 : 1);
    inDegree.set(id, 0);
  }
  for (const edges of out.values()) {
    for (const { edge, index } of edges) {
      if (!back.has(index)) inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
    }
  }

  // Kahn's algorithm. The queue is seeded and extended in graph order, so the
  // visit order, and with it the ranks, never depend on anything but the input.
  const queue = order.filter((id) => inDegree.get(id) === 0);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    for (const { edge, index } of out.get(id) ?? []) {
      if (back.has(index)) continue;
      rank.set(edge.to, Math.max(rank.get(edge.to)!, rank.get(id)! + 1));
      const remaining = inDegree.get(edge.to)! - 1;
      inDegree.set(edge.to, remaining);
      if (remaining === 0) queue.push(edge.to);
    }
  }
  if (queue.length !== order.length) {
    throw new Error('Cannot lay out graph: a cycle survived back-edge removal');
  }
  return rank;
}

/** Position of each node in its column, as a fraction in (0, 1). */
function fractions(columns: readonly (readonly string[])[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const column of columns) {
    column.forEach((id, index) => result.set(id, (index + 0.5) / column.length));
  }
  return result;
}

/**
 * One barycentre sweep. Columns are visited in `visit` order; each is sorted by
 * the mean position of its neighbours (`neighbours`: predecessors on a sweep to
 * the right, successors on a sweep to the left). A node with no neighbours on
 * that side keeps its current position. Ties fall to the node id.
 */
function sweep(
  columns: string[][],
  visit: readonly number[],
  neighbours: ReadonlyMap<string, string[]>,
): void {
  for (const k of visit) {
    const position = fractions(columns);
    const column = columns[k]!;
    const barycentre = new Map<string, number>();
    for (const id of column) {
      const near = neighbours.get(id) ?? [];
      barycentre.set(
        id,
        near.length === 0
          ? position.get(id)!
          : near.reduce((sum, other) => sum + position.get(other)!, 0) / near.length,
      );
    }
    column.sort((a, b) => barycentre.get(a)! - barycentre.get(b)! || compareStrings(a, b));
  }
}

/**
 * One group with the node ids of its members, in order. A collapsed group
 * (#502) is its one node, drawn in the group's place without a box.
 */
interface GroupMembers {
  group: FunctionGroup;
  ids: string[];
  collapsed?: true;
}

/** A function's order in column 0: groups first (as `groupFunctions` ranks them). */
function orderFunctions(functions: readonly Extract<GraphNode, { kind: 'function' }>[]): {
  ids: string[];
  groups: GroupMembers[];
  groupOf: Map<string, string>;
} {
  // A collapsed group (#502) is grouped by its members, and takes their place.
  const names = functions.flatMap((f) => (f.collapsed ? f.collapsed.members : [f.name]));
  const groups = groupFunctions(names);
  if (groups.length === 0) {
    return { ids: functions.map((f) => f.id), groups: [], groupOf: new Map() };
  }
  const idByName = new Map(functions.filter((f) => !f.collapsed).map((f) => [f.name, f.id]));
  const collapsedId = new Map(
    functions.filter((f) => f.collapsed).map((f) => [f.collapsed!.group, f.id]),
  );
  const ids: string[] = [];
  const groupOf = new Map<string, string>();
  const members: GroupMembers[] = [];
  for (const group of groups) {
    const collapsed = collapsedId.get(group.name);
    if (collapsed) {
      ids.push(collapsed);
      members.push({ group, ids: [collapsed], collapsed: true });
      continue;
    }
    const memberIds = group.functions.map((name) => idByName.get(name)!);
    for (const id of memberIds) {
      ids.push(id);
      groupOf.set(id, `group:${group.name}`);
    }
    members.push({ group, ids: memberIds });
  }
  return { ids, groups: members, groupOf };
}

/**
 * Lays out an abstract contract graph in columns. Pure and synchronous.
 *
 * The positions are final except for edge routes: pass the result to
 * `routeDiagram` to resolve ports and channels. Throws on a malformed graph
 * (duplicate node ids, an edge to a node that does not exist) and on invalid
 * geometry options, rather than drawing something misleading.
 */
export function layoutContractGraph(
  graph: ContractGraph,
  opts: LayoutGeometryOptions = {},
  overlays: LayoutOverlays = {},
): PositionedDiagramModel {
  const geo = resolveGeometry(opts);

  if (graph.nodes.length > MAX_RAW_NODES) {
    return {
      layoutVersion: LAYOUT_VERSION,
      status: 'too-large',
      tooLarge: true,
      rawNodeCount: graph.nodes.length,
      width: 0,
      height: 0,
      nodes: [],
      edges: [],
      groups: [],
    };
  }

  const nodeById = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      throw new Error(`Cannot lay out graph: duplicate node id ${node.id}`);
    }
    nodeById.set(node.id, node);
  }
  const out = new Map<string, OutEdge[]>();
  graph.edges.forEach((edge, index) => {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) {
      const missing = nodeById.has(edge.from) ? edge.to : edge.from;
      throw new Error(
        `Cannot lay out edge ${edge.from} -> ${edge.to}: node ${missing} does not exist`,
      );
    }
    const list = out.get(edge.from);
    if (list) list.push({ edge, index });
    else out.set(edge.from, [{ edge, index }]);
  });

  const functions = graph.nodes.filter(
    (n): n is Extract<GraphNode, { kind: 'function' }> => n.kind === 'function',
  );
  const others = graph.nodes.filter((n) => n.kind !== 'function');
  const order = [...functions, ...others].map((n) => n.id);
  const kindOf = new Map(graph.nodes.map((n) => [n.id, n.kind] as const));

  const back = findBackEdges(order, out, kindOf);
  const rank = assignRanks(order, out, kindOf, back);

  // Columns: rank -> node ids. Column 0 is the grouped function order.
  const fnOrder = orderFunctions(functions);
  const maxRank = Math.max(0, ...order.map((id) => rank.get(id)!));
  const columns: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  columns[0] = [...fnOrder.ids];
  for (const node of others) columns[rank.get(node.id)!]!.push(node.id);

  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  graph.edges.forEach((edge, index) => {
    if (back.has(index)) return;
    link(preds, edge.to, edge.from);
    link(succs, edge.from, edge.to);
  });

  const rightwards = Array.from({ length: maxRank }, (_, i) => i + 1);
  const leftwards = Array.from({ length: Math.max(0, maxRank - 1) }, (_, i) => maxRank - 1 - i);
  for (let s = 0; s < SWEEPS; s++) {
    if (s % 2 === 0) sweep(columns, rightwards, preds);
    else sweep(columns, leftwards, succs);
  }

  // The call graph overlay: its own right-most column, and the anchor.
  const calls = placeCalls(overlays.calls, functions, geo.nodeHeight);
  if (calls.callees.length > 0) columns.push(calls.callees.map((c) => c.id));
  if (calls.anchor) columns[0]!.unshift(CALL_ANCHOR_ID);

  // Sizes. A label wider than the cap is cut, and keeps its full name.
  const cell = textWidth('x', geo.fontSizePx);
  const maxCells = Math.floor((geo.maxNodeWidth - 2 * geo.nodePaddingX) / cell + 1e-9);
  const size = new Map<string, { label: string; width: number; truncated: boolean }>();
  // A callee's plain-language label ("USDC (asset contract, issuer G…KZVN)")
  // is the point of the column, so the overlay's nodes get half again the cap.
  const callMaxWidth = Math.round(geo.maxNodeWidth * 1.5);
  const callMaxCells = Math.floor((callMaxWidth - 2 * geo.nodePaddingX) / cell + 1e-9);
  const sizedNodes: { id: string; name: string; call?: true }[] = [
    ...graph.nodes,
    ...calls.callees.map((c) => ({ ...c, call: true as const })),
    ...(calls.anchor ? [{ id: CALL_ANCHOR_ID, name: ANCHOR_NAME, call: true as const }] : []),
  ];
  for (const node of sizedNodes) {
    const slot = node.id.startsWith('fn:') ? MARK_SLOT : 0;
    const cap = node.call ? callMaxWidth : geo.maxNodeWidth;
    const fits = Math.ceil(textWidth(node.name, geo.fontSizePx)) + 2 * geo.nodePaddingX + slot;
    const truncated = fits > cap;
    const label = truncated
      ? truncateLabel(
          node.name,
          node.call ? callMaxCells : Math.max(1, maxCells - Math.ceil(slot / cell)),
        )
      : node.name;
    size.set(node.id, {
      label,
      width: Math.ceil(textWidth(label, geo.fontSizePx)) + 2 * geo.nodePaddingX + slot,
      truncated,
    });
  }

  // Space around the diagram: back edges need the router's lanes above and beside.
  const backCount = back.size;
  const top = geo.margin + (backCount > 0 ? BACK_LANE_BASE + backCount * BACK_LANE_STEP : 0);
  const side = backCount > 0 ? Math.max(geo.margin, BACK_LANE_BASE) : geo.margin;

  // Column x: left-aligned, so every node in a column shares one x.
  const columnWidth = columns.map((column) =>
    column.length === 0 ? 0 : Math.max(...column.map((id) => size.get(id)!.width)),
  );
  const columnX: number[] = [];
  columns.forEach((_, k) => {
    columnX.push(k === 0 ? side : columnX[k - 1]! + columnWidth[k - 1]! + geo.columnGutter);
  });

  // Column heights, to centre the shorter columns on the tallest.
  const stackHeight = (count: number) =>
    count === 0 ? 0 : count * geo.nodeHeight + (count - 1) * geo.rowGap;
  const groupMembers = fnOrder.groups.map((g) => g.ids.length);
  const blockHeight = (g: GroupMembers) =>
    g.collapsed
      ? geo.nodeHeight
      : geo.groupHeaderHeight + stackHeight(g.ids.length) + geo.groupPadding;
  const groupedHeight =
    groupMembers.length === 0
      ? 0
      : fnOrder.groups.reduce((sum, g) => sum + blockHeight(g), 0) +
        (groupMembers.length - 1) * geo.groupGap;
  // The anchor sits above the functions, a group gap clear of the first box.
  const anchorShift = calls.anchor
    ? geo.nodeHeight + (groupMembers.length > 0 ? geo.groupGap : geo.rowGap)
    : 0;
  // A callee is tall enough to give every edge into it its own port band, so
  // their count labels never overlap.
  const heightOf = (id: string) => calls.heights.get(id) ?? geo.nodeHeight;
  const columnStack = (column: readonly string[]) =>
    column.length === 0
      ? 0
      : column.reduce((sum, id) => sum + heightOf(id), 0) + (column.length - 1) * geo.rowGap;
  const heights = columns.map((column, k) =>
    k === 0 && groupMembers.length > 0 ? groupedHeight + anchorShift : columnStack(column),
  );
  const tallest = Math.max(0, ...heights);

  const pos = new Map<string, { x: number; y: number }>();
  const groups: PositionedGroup[] = [];
  if (calls.anchor) pos.set(CALL_ANCHOR_ID, { x: columnX[0]!, y: top });
  let cursor = top + anchorShift;
  if (groupMembers.length > 0) {
    for (const { group, ids, collapsed } of fnOrder.groups) {
      if (collapsed) {
        pos.set(ids[0]!, { x: columnX[0]!, y: cursor });
        cursor += geo.nodeHeight + geo.groupGap;
        continue;
      }
      const boxY = cursor;
      let y = boxY + geo.groupHeaderHeight;
      for (const id of ids) {
        pos.set(id, { x: columnX[0]!, y });
        y += geo.nodeHeight + geo.rowGap;
      }
      const height = geo.groupHeaderHeight + stackHeight(ids.length) + geo.groupPadding;
      groups.push({
        id: `group:${group.name}`,
        name: group.name,
        kind: group.kind,
        nodeIds: ids,
        x: columnX[0]! - geo.groupPadding,
        y: boxY,
        width: columnWidth[0]! + 2 * geo.groupPadding,
        height,
      });
      cursor = boxY + height + geo.groupGap;
    }
  } else {
    // The anchor, when there is one, is first in the column already.
    columns[0]!.forEach((id, i) => {
      pos.set(id, { x: columnX[0]!, y: top + i * (geo.nodeHeight + geo.rowGap) });
    });
  }
  for (let k = 1; k < columns.length; k++) {
    const offset = Math.floor((tallest - heights[k]!) / 2);
    let y = top + offset;
    for (const id of columns[k]!) {
      pos.set(id, { x: columnX[k]!, y });
      y += heightOf(id) + geo.rowGap;
    }
  }

  const columnOf = new Map<string, number>();
  columns.forEach((column, k) => column.forEach((id) => columnOf.set(id, k)));

  const nodes: PositionedNode[] = graph.nodes.map((node) => {
    const { label, width, truncated } = size.get(node.id)!;
    const { x, y } = pos.get(node.id)!;
    const positioned: PositionedNode = {
      id: node.id,
      label,
      x,
      y,
      width,
      height: geo.nodeHeight,
      kind: node.kind,
      name: node.name,
      truncated,
      column: columnOf.get(node.id)!,
    };
    if (node.kind === 'type') positioned.typeKind = node.typeKind;
    if (node.kind === 'function' && node.collapsed) {
      positioned.collapsed = { group: node.collapsed.group, members: [...node.collapsed.members] };
    }
    const groupId = fnOrder.groupOf.get(node.id);
    if (groupId !== undefined) positioned.groupId = groupId;
    return positioned;
  });

  const callNode = (id: string, kind: CallNodeKind, name: string): PositionedNode => {
    const { label, width, truncated } = size.get(id)!;
    const { x, y } = pos.get(id)!;
    return {
      id,
      label,
      x,
      y,
      width,
      height: heightOf(id),
      kind,
      name,
      truncated,
      column: columnOf.get(id)!,
    };
  };
  if (calls.anchor) nodes.push(callNode(CALL_ANCHOR_ID, 'call-anchor', ANCHOR_NAME));
  for (const callee of calls.callees) {
    const node = callNode(callee.id, callee.kind, callee.name);
    if (callee.address !== undefined) node.address = callee.address;
    if (callee.hidden !== undefined) node.hiddenAddresses = callee.hidden;
    nodes.push(node);
  }

  const edges: PositionedEdge[] = graph.edges.map((edge, index) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kinds: edge.kinds,
    back: back.has(index),
  }));
  for (const call of calls.edges) {
    edges.push({
      id: `${call.from}->${call.to}`,
      from: call.from,
      to: call.to,
      kinds: ['call'],
      back: false,
      call: call.call,
    });
  }

  const lastColumn = columns.length - 1;
  const hasNodes = sizedNodes.length > 0;
  const model: PositionedDiagramModel = {
    layoutVersion: LAYOUT_VERSION,
    width: hasNodes ? columnX[lastColumn]! + columnWidth[lastColumn]! + side : 2 * geo.margin,
    height: top + tallest + geo.margin,
    nodes,
    edges,
    groups,
  };
  if (calls.summary) model.calls = calls.summary;
  return model;
}

const ANCHOR_NAME = 'contract (function unknown)';

/** Vertical room per edge entering a callee: one 12px count label and air. */
const CALL_PORT_BAND = 16;

interface PlacedCallee {
  id: string;
  kind: 'callee' | 'callees-more';
  name: string;
  address?: string;
  hidden?: string[];
}

interface PlacedCalls {
  callees: PlacedCallee[];
  /** Callee heights, where more edges come in than one node height holds. */
  heights: Map<string, number>;
  anchor: boolean;
  edges: { from: string; to: string; call: PositionedCall }[];
  summary: CallSummary | null;
}

const EVIDENCE_RANK: Record<CallEvidence, number> = { footprint: 0, event: 1, 'auth-tree': 2 };

/**
 * The overlay's callees in column order, the edges into them (merged into
 * "+K other contracts" past the cap), and whether any call needs the anchor.
 * A call from a function the spec does not have starts from the anchor too.
 */
function placeCalls(
  input: LayoutOverlays['calls'],
  functions: readonly Extract<GraphNode, { kind: 'function' }>[],
  nodeHeight: number,
): PlacedCalls {
  const none: PlacedCalls = {
    callees: [],
    heights: new Map(),
    anchor: false,
    edges: [],
    summary: null,
  };
  if (!input || input.overlay.edges.length === 0) return none;
  const { overlay } = input;
  // A call from a member of a collapsed group starts from the group's node.
  const fnId = new Map(
    functions.flatMap((f) =>
      f.collapsed
        ? f.collapsed.members.map((name) => [name, f.id] as const)
        : [[f.name, f.id] as const],
    ),
  );

  const weightOf = new Map<string, number>();
  for (const e of overlay.edges) {
    weightOf.set(e.to, (weightOf.get(e.to) ?? 0) + e.transactions + e.sandboxRuns);
  }
  const order = [...weightOf.keys()].sort(
    (a, b) => weightOf.get(b)! - weightOf.get(a)! || compareStrings(a, b),
  );
  const collapse = !input.expand && order.length > MAX_CALLEES;
  const shown = collapse ? order.slice(0, MAX_CALLEES) : order;
  const hidden = collapse ? order.slice(MAX_CALLEES) : [];

  const callees: PlacedCallee[] = shown.map((address) => ({
    id: calleeNodeId(address),
    kind: 'callee',
    name: input.labels?.get(address) ?? `${address.slice(0, 4)}…${address.slice(-4)}`,
    address,
  }));
  if (hidden.length > 0) {
    callees.push({
      id: CALLEES_MORE_ID,
      kind: 'callees-more',
      name: `+${hidden.length} other contract${hidden.length === 1 ? '' : 's'}`,
      hidden,
    });
  }

  const hiddenSet = new Set(hidden);
  const merged = new Map<
    string,
    { from: string; to: string; count: number; evidence: CallEvidence | null; sandboxRuns: number }
  >();
  let anchor = false;
  for (const e of overlay.edges) {
    const from = (e.from !== null ? fnId.get(e.from) : undefined) ?? CALL_ANCHOR_ID;
    if (from === CALL_ANCHOR_ID) anchor = true;
    const to = hiddenSet.has(e.to) ? CALLEES_MORE_ID : calleeNodeId(e.to);
    const key = `${from}->${to}`;
    const m = merged.get(key) ?? { from, to, count: 0, evidence: null, sandboxRuns: 0 };
    m.count += e.transactions + e.sandboxRuns;
    m.sandboxRuns += e.sandboxRuns;
    if (
      e.evidence !== null &&
      (m.evidence === null || EVIDENCE_RANK[e.evidence] > EVIDENCE_RANK[m.evidence])
    ) {
      m.evidence = e.evidence;
    }
    merged.set(key, m);
  }

  // Stroke weight by tercile of the drawn edges' counts.
  const counts = [...merged.values()].map((m) => m.count).sort((a, b) => a - b);
  const t1 = counts[Math.floor((counts.length - 1) / 3)]!;
  const t2 = counts[Math.floor((2 * (counts.length - 1)) / 3)]!;
  const edges = [...merged.values()].map((m) => ({
    from: m.from,
    to: m.to,
    call: {
      count: m.count,
      evidence: m.evidence,
      sandboxRuns: m.sandboxRuns,
      weight: (m.count <= t1 ? 1 : m.count <= t2 ? 2 : 3) as 1 | 2 | 3,
    },
  }));

  const incoming = new Map<string, number>();
  for (const e of edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  const heights = new Map<string, number>();
  for (const [id, n] of incoming) {
    const needed = (n + 1) * CALL_PORT_BAND;
    if (needed > nodeHeight) heights.set(id, needed);
  }

  return {
    callees,
    heights,
    anchor,
    edges,
    summary: {
      transactions: overlay.transactions,
      firstLedger: overlay.firstLedger,
      lastLedger: overlay.lastLedger,
      sandboxRuns: overlay.sandboxRuns,
      shown: shown.length,
      hidden: hidden.length,
    },
  };
}
