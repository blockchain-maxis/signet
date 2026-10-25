/**
 * @file Collapse and expand function groups (#502, design §3).
 *
 * A contract with many functions draws them in groups (#484); past
 * {@link COLLAPSE_THRESHOLD} functions every group collapses to one node,
 * `pool_* (12)`, that links to the URL expanding it. Expansion state lives
 * in the URL (`?expand=pool,admin`) and the server draws it, so it works
 * without JavaScript; the client enhancer (`interactive/expand.ts`) only
 * swaps the drawn diagram in place.
 *
 * This is a pass over the abstract graph, before layout: a collapsed
 * group's member nodes are replaced by one function node, and their edges
 * are merged onto it. Pure and deterministic, like the rest of the core.
 */

import type {
  CollapsedGroup,
  ContractGraph,
  EdgeRole,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
} from './graph.ts';
import { groupFunctions, type FunctionGroup } from './group.ts';

/** Past this many functions, groups collapse unless the URL expands them. */
export const COLLAPSE_THRESHOLD = 25;

/** Node id prefix of a collapsed group: `collapsed:pool`. */
export const COLLAPSED_PREFIX = 'collapsed:';

export function collapsedGroupId(group: string): string {
  return `${COLLAPSED_PREFIX}${group}`;
}

/** A collapsed group's label: `pool_* (12)`, or `other (4)` for a synthetic group. */
export function collapsedLabel(group: FunctionGroup): string {
  const n = group.functions.length;
  return group.kind === 'prefix' ? `${group.name}_* (${n})` : `${group.name} (${n})`;
}

export interface CollapseOptions {
  /** Groups to draw expanded, by name. Names that are no group are ignored. */
  readonly expand?: readonly string[];
  /** Default {@link COLLAPSE_THRESHOLD}. */
  readonly threshold?: number;
}

/** The function groups of a graph, as the layout draws them. */
export function functionGroupsOf(graph: ContractGraph): FunctionGroup[] {
  return groupFunctions(graph.nodes.filter((n) => n.kind === 'function').map((n) => n.name));
}

/**
 * The groups a URL's `expand` list names, checked against the graph's own
 * group names, without duplicates and sorted, so permuted lists give the same
 * state (and cache key). Anything that is not a group name is dropped, never
 * echoed back.
 */
export function canonicalExpand(
  raw: string | readonly string[] | null | undefined,
  graph: ContractGraph,
): string[] {
  const names = new Set(functionGroupsOf(graph).map((g) => g.name));
  const asked = typeof raw === 'string' ? raw.split(',') : (raw ?? []);
  return [...new Set(asked.map((name) => name.trim()).filter((name) => names.has(name)))].sort();
}

/**
 * Collapses every function group not in `expand` to one node, when the
 * graph has more than `threshold` functions. Groups of one function stay as
 * they are. Below the threshold, or with no groups, the graph comes back as
 * it was.
 */
export function collapseGroups(graph: ContractGraph, opts: CollapseOptions = {}): ContractGraph {
  const functions = graph.nodes.filter((n) => n.kind === 'function');
  if (functions.length <= (opts.threshold ?? COLLAPSE_THRESHOLD)) return graph;
  const expand = new Set(opts.expand ?? []);
  const groups = groupFunctions(functions.map((n) => n.name)).filter(
    (g) => g.functions.length > 1 && !expand.has(g.name),
  );
  if (groups.length === 0) return graph;

  // Member function id -> the collapsed node standing for it.
  const into = new Map<string, GraphNode>();
  for (const group of groups) {
    const collapsed: CollapsedGroup = { group: group.name, members: group.functions };
    const node: GraphNode = {
      id: collapsedGroupId(group.name),
      kind: 'function',
      name: collapsedLabel(group),
      collapsed,
    };
    for (const name of group.functions) into.set(`fn:${name}`, node);
  }

  const nodes: GraphNode[] = [];
  const placed = new Set<string>();
  for (const node of graph.nodes) {
    const target = into.get(node.id);
    if (!target) nodes.push(node);
    else if (!placed.has(target.id)) {
      placed.add(target.id);
      nodes.push(target);
    }
  }

  // Edges from members merge onto the collapsed node, one per target, in
  // discovery order.
  const merged = new Map<
    string,
    { from: string; to: string; kinds: GraphEdgeKind[]; roles: EdgeRole[] }
  >();
  for (const edge of graph.edges) {
    const from = into.get(edge.from)?.id ?? edge.from;
    const id = `${from}->${edge.to}`;
    let m = merged.get(id);
    if (!m) {
      m = { from, to: edge.to, kinds: [], roles: [] };
      merged.set(id, m);
    }
    for (const kind of edge.kinds) if (!m.kinds.includes(kind)) m.kinds.push(kind);
    m.roles.push(...edge.roles);
  }
  const edges: GraphEdge[] = [...merged].map(([id, m]) => ({ id, ...m }));
  return { ...graph, nodes, edges };
}
