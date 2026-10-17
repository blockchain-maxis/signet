/**
 * @file Type-graph depth policy over the abstract contract graph (#490, #502).
 *
 * `buildTypeGraph` applies the depth policy while building the type graph from
 * a spec. The page's diagram pipeline builds the abstract graph first
 * (`buildContractGraph`), so it needs the same policy as a graph-to-graph
 * pass. This module is that pass: it walks the function → type → type edges,
 * keeps the types up to `typeDepth` nested levels, and marks the rest as
 * stubs. A stub keeps its node — and therefore its docs link — but loses its
 * outgoing member edges, so a deep router does not draw its whole type
 * hairball at once.
 *
 * `expandTypes` opens named stubs one level further, which is what the
 * per-type `?types=` control (#502) drives from the URL. Opening a stub does
 * not recursively open the types below it: the extra level's own children are
 * then one level past the limit again, exactly as `buildTypeGraph` behaves.
 *
 * Pure and deterministic: node order is the graph's order, edge order is the
 * graph's order, and the walk visits in that order.
 */

import type { ContractGraph, GraphEdge, GraphNode, TypeNode } from './graph.ts';
import { DEFAULT_TYPE_DEPTH } from './type-graph.ts';

/** Which types to draw inline, mirroring `TypeGraphOptions`. */
export interface TypeDepthOptions {
  /** Nesting levels below a function signature drawn inline. Default 1. */
  readonly typeDepth?: number;
  /** Type names to open one level past `typeDepth`. */
  readonly expandTypes?: readonly string[];
}

/** True for a node that can hold member edges. */
function isTypeNode(node: GraphNode): node is TypeNode {
  return node.kind === 'type';
}

/**
 * Apply the type-depth policy to an abstract graph.
 *
 * A type's depth is the shortest path from any function signature, counting
 * named-type nesting (wrappers do not add a level). Types nothing reaches are
 * left as they are: the graph builder only emits types the spec defines and
 * this pass has no reason to hide one the caller already chose to draw.
 */
export function limitTypeDepth(
  graph: ContractGraph,
  options: TypeDepthOptions = {},
): ContractGraph {
  const typeDepth = options.typeDepth ?? DEFAULT_TYPE_DEPTH;
  const forced = new Set(options.expandTypes ?? []);
  const byId = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  const see = (id: string, level: number): void => {
    const known = depth.get(id);
    if (known !== undefined && known <= level) return;
    depth.set(id, level);
    const node = byId.get(id);
    if (node !== undefined && isTypeNode(node)) queue.push(id);
  };

  // Signatures root the graph: every type a function names is level 1.
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    if (from?.kind !== 'function') continue;
    const to = byId.get(edge.to);
    if (to !== undefined && to.kind !== 'function') see(edge.to, 1);
  }
  // Breadth-first over member edges, so the shallowest level always wins.
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const level = depth.get(id)!;
    for (const edge of outgoing.get(id) ?? []) {
      const to = byId.get(edge.to);
      if (to !== undefined && to.kind !== 'function') see(edge.to, level + 1);
    }
  }

  const isInline = (node: GraphNode): boolean => {
    if (node.kind !== 'type') return true;
    const level = depth.get(node.id);
    if (level === undefined) return true;
    return level <= typeDepth || forced.has(node.name);
  };

  const stubs = new Set<string>();
  const nodes: GraphNode[] = graph.nodes.map((node) => {
    if (node.kind !== 'type') return node;
    if (isInline(node))
      return { id: node.id, kind: node.kind, name: node.name, typeKind: node.typeKind };
    stubs.add(node.id);
    const hidden = (outgoing.get(node.id) ?? []).filter((edge) => {
      const to = byId.get(edge.to);
      return to !== undefined && to.kind === 'type';
    }).length;
    return { ...node, stub: true, hidden };
  });

  const edges = graph.edges.filter((edge) => !stubs.has(edge.from));
  return { ...graph, nodes, edges };
}
