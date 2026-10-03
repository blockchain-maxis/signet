import type { DiagramEdge, DiagramModel, DiagramNode } from './index.ts';

/** A point in the diagram's coordinate system. */
export interface Point {
  x: number;
  y: number;
}

/** The geometry the routing pass needs from a laid-out node. */
export interface RoutableNode extends DiagramNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An edge before routing; #486 marks recursive relationships as back edges. */
export interface RoutableEdge extends DiagramEdge {
  back?: boolean;
}

/** An edge after its source and target ports have been resolved. */
export type RoutedEdge<E extends RoutableEdge = RoutableEdge> = E & {
  polyline: Point[];
};

export interface RouteOptions {
  /** Distance between parallel long-edge and back-edge channels. */
  channelGap?: number;
  /** Minimum distance kept between a long-edge channel and a node. */
  nodeClearance?: number;
  /** Distance from the columns used for an outside back-edge lane. */
  outsidePadding?: number;
}

const DEFAULT_CHANNEL_GAP = 8;
const DEFAULT_NODE_CLEARANCE = 4;
const DEFAULT_OUTSIDE_PADDING = 16;

interface Column {
  x: number;
  left: number;
  right: number;
}

interface IndexedEdge<E extends RoutableEdge> {
  edge: E;
  index: number;
  source: RoutableNode;
  target: RoutableNode;
  sourceColumn: number;
  targetColumn: number;
  sourcePort?: Point;
  targetPort?: Point;
}

/**
 * Add deterministic orthogonal routes to a set of positioned edges.
 *
 * Short forward edges turn in the gutter between their columns. Edges that
 * skip columns use a clear horizontal channel through the intervening
 * columns, while back edges use separate lanes above the whole layout.
 */
export function routeEdges<E extends RoutableEdge>(
  nodes: readonly RoutableNode[],
  edges: readonly E[],
  options: RouteOptions = {},
): RoutedEdge<E>[] {
  const channelGap = positiveOption(options.channelGap, DEFAULT_CHANNEL_GAP, 'channelGap');
  const nodeClearance = nonNegativeOption(
    options.nodeClearance,
    DEFAULT_NODE_CLEARANCE,
    'nodeClearance',
  );
  const outsidePadding = nonNegativeOption(
    options.outsidePadding,
    DEFAULT_OUTSIDE_PADDING,
    'outsidePadding',
  );
  const nodeById = indexNodes(nodes);
  const columns = collectColumns(nodes);
  const columnByX = new Map(columns.map((column, index) => [column.x, index]));
  const indexed = edges.map((edge, index): IndexedEdge<E> => {
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (source === undefined || target === undefined) {
      const missing = source === undefined ? edge.from : edge.to;
      throw new Error(
        `Cannot route edge ${edge.from} -> ${edge.to}: node ${missing} does not exist`,
      );
    }

    return {
      edge,
      index,
      source,
      target,
      sourceColumn: columnByX.get(source.x)!,
      targetColumn: columnByX.get(target.x)!,
    };
  });

  assignPorts(indexed);

  const routeOrder = [...indexed].sort(compareIndexedEdges);
  const usedLongChannels: number[] = [];
  let backLane = 0;
  const routed = new Map<number, RoutedEdge<E>>();
  const layoutTop = nodes.length === 0 ? 0 : Math.min(...nodes.map((node) => node.y));

  for (const item of routeOrder) {
    const sourcePort = item.sourcePort!;
    const targetPort = item.targetPort!;
    const isBackEdge = item.edge.back === true || item.targetColumn <= item.sourceColumn;
    let polyline: Point[];

    if (isBackEdge) {
      const sourceGutter = rightGutter(item.sourceColumn, columns, outsidePadding);
      const targetGutter = leftGutter(item.targetColumn, columns, outsidePadding);
      const laneY = layoutTop - outsidePadding - backLane * channelGap;
      backLane += 1;
      polyline = compactPolyline([
        sourcePort,
        { x: sourceGutter, y: sourcePort.y },
        { x: sourceGutter, y: laneY },
        { x: targetGutter, y: laneY },
        { x: targetGutter, y: targetPort.y },
        targetPort,
      ]);
    } else if (item.targetColumn === item.sourceColumn + 1) {
      const gutter = (columns[item.sourceColumn]!.right + columns[item.targetColumn]!.left) / 2;
      polyline = compactPolyline([
        sourcePort,
        { x: gutter, y: sourcePort.y },
        { x: gutter, y: targetPort.y },
        targetPort,
      ]);
    } else {
      const sourceGutter = rightGutter(item.sourceColumn, columns, outsidePadding);
      const targetGutter = leftGutter(item.targetColumn, columns, outsidePadding);
      const intermediate = nodes.filter((node) => {
        const column = columnByX.get(node.x)!;
        return column > item.sourceColumn && column < item.targetColumn;
      });
      const desiredY = (sourcePort.y + targetPort.y) / 2;
      const channelY = clearChannel(
        desiredY,
        intermediate,
        usedLongChannels,
        channelGap,
        nodeClearance,
      );
      usedLongChannels.push(channelY);
      polyline = compactPolyline([
        sourcePort,
        { x: sourceGutter, y: sourcePort.y },
        { x: sourceGutter, y: channelY },
        { x: targetGutter, y: channelY },
        { x: targetGutter, y: targetPort.y },
        targetPort,
      ]);
    }

    routed.set(item.index, { ...item.edge, polyline });
  }

  return edges.map((_, index) => routed.get(index)!);
}

/** Route every edge in a positioned diagram without mutating the model. */
export function routeDiagram<
  N extends RoutableNode,
  E extends RoutableEdge,
  M extends DiagramModel & { nodes: N[]; edges: E[] },
>(model: M, options?: RouteOptions): Omit<M, 'edges'> & { edges: RoutedEdge<E>[] } {
  return { ...model, edges: routeEdges(model.nodes, model.edges, options) };
}

function indexNodes(nodes: readonly RoutableNode[]): Map<string, RoutableNode> {
  const result = new Map<string, RoutableNode>();
  for (const node of nodes) {
    if (result.has(node.id)) throw new Error(`Cannot route diagram: duplicate node id ${node.id}`);
    if (![node.x, node.y, node.width, node.height].every(Number.isFinite)) {
      throw new Error(`Cannot route diagram: node ${node.id} has invalid geometry`);
    }
    if (node.width <= 0 || node.height <= 0) {
      throw new Error(`Cannot route diagram: node ${node.id} has non-positive dimensions`);
    }
    result.set(node.id, node);
  }
  return result;
}

function collectColumns(nodes: readonly RoutableNode[]): Column[] {
  const byX = new Map<number, RoutableNode[]>();
  for (const node of nodes) {
    const column = byX.get(node.x);
    if (column === undefined) byX.set(node.x, [node]);
    else column.push(node);
  }

  return [...byX.entries()]
    .sort(([left], [right]) => left - right)
    .map(([x, columnNodes]) => ({
      x,
      left: Math.min(...columnNodes.map((node) => node.x)),
      right: Math.max(...columnNodes.map((node) => node.x + node.width)),
    }));
}

function assignPorts<E extends RoutableEdge>(edges: IndexedEdge<E>[]): void {
  const outgoing = groupEdges(edges, (edge) => edge.source.id);
  const incoming = groupEdges(edges, (edge) => edge.target.id);

  for (const nodeEdges of outgoing.values()) {
    nodeEdges.sort(
      (left, right) =>
        compareNumbers(centerY(left.target), centerY(right.target)) ||
        compareIndexedEdges(left, right),
    );
    nodeEdges.forEach((edge, index) => {
      edge.sourcePort = {
        x: edge.source.x + edge.source.width,
        y: spreadPort(edge.source, index, nodeEdges.length),
      };
    });
  }

  for (const nodeEdges of incoming.values()) {
    nodeEdges.sort(
      (left, right) =>
        compareNumbers(centerY(left.source), centerY(right.source)) ||
        compareIndexedEdges(left, right),
    );
    nodeEdges.forEach((edge, index) => {
      edge.targetPort = {
        x: edge.target.x,
        y: spreadPort(edge.target, index, nodeEdges.length),
      };
    });
  }
}

function groupEdges<E extends RoutableEdge>(
  edges: IndexedEdge<E>[],
  key: (edge: IndexedEdge<E>) => string,
): Map<string, IndexedEdge<E>[]> {
  const groups = new Map<string, IndexedEdge<E>[]>();
  for (const edge of edges) {
    const id = key(edge);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [edge]);
    else group.push(edge);
  }
  return groups;
}

function spreadPort(node: RoutableNode, index: number, count: number): number {
  return node.y + (node.height * (index + 1)) / (count + 1);
}

function clearChannel(
  desired: number,
  nodes: readonly RoutableNode[],
  used: readonly number[],
  gap: number,
  clearance: number,
): number {
  const available = (y: number): boolean =>
    !used.some((other) => Math.abs(other - y) < gap) &&
    !nodes.some((node) => y >= node.y - clearance && y <= node.y + node.height + clearance);

  if (available(desired)) return desired;
  for (let step = 1; ; step += 1) {
    const above = desired - step * gap;
    if (available(above)) return above;
    const below = desired + step * gap;
    if (available(below)) return below;
  }
}

function rightGutter(column: number, columns: readonly Column[], outsidePadding: number): number {
  const current = columns[column]!;
  const next = columns[column + 1];
  return next === undefined ? current.right + outsidePadding : (current.right + next.left) / 2;
}

function leftGutter(column: number, columns: readonly Column[], outsidePadding: number): number {
  const current = columns[column]!;
  const previous = columns[column - 1];
  return previous === undefined
    ? current.left - outsidePadding
    : (previous.right + current.left) / 2;
}

function compactPolyline(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last?.x === point.x && last.y === point.y) continue;
    result.push(point);
    while (result.length >= 3) {
      const a = result.at(-3)!;
      const b = result.at(-2)!;
      const c = result.at(-1)!;
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
        result.splice(result.length - 2, 1);
      } else {
        break;
      }
    }
  }
  return result;
}

function compareIndexedEdges<E extends RoutableEdge>(
  left: IndexedEdge<E>,
  right: IndexedEdge<E>,
): number {
  return (
    left.edge.from.localeCompare(right.edge.from) ||
    left.edge.to.localeCompare(right.edge.to) ||
    (left.edge.label ?? '').localeCompare(right.edge.label ?? '') ||
    left.index - right.index
  );
}

function centerY(node: RoutableNode): number {
  return node.y + node.height / 2;
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be a positive number`);
  return result;
}

function nonNegativeOption(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 0)
    throw new Error(`${name} must be a non-negative number`);
  return result;
}
