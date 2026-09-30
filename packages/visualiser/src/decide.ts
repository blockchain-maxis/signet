/**
 * @file Diagram worth-drawing decision (#489, design §3).
 *
 * The registry (8 functions, no types, no edges) shouldn't be drawn because
 * the docs already say everything a diagram could. Above ~60 nodes after
 * grouping, a diagram becomes a picture nobody can read. This module exports
 * one explicit decision function so the thresholds live in one place and can
 * be recalibrated.
 *
 * The `ContractGraph`, `GraphNode`, and `GraphEdge` types are provisional
 * mirrors of #482's abstract contract graph. When #482 lands, this module
 * will import from its `src/graph.ts` instead.
 */

import type { DiagramModel } from './index.ts';

/**
 * A node in the abstract contract graph from the decoded spec.
 * Mirrors the future #482 `GraphNode` shape.
 */
export interface GraphNode {
  /** Stable id: `fn:<name>` or `type:<name>`. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** `function` or `type`. */
  kind: 'function' | 'type';
}

/**
 * A directed edge in the abstract contract graph.
 * Mirrors the future #482 `GraphEdge` shape.
 */
export interface GraphEdge {
  /** Source node id. */
  from: string;
  /** Target node id. */
  to: string;
  /** `arg` | `return` | `field`. */
  kind: 'arg' | 'return' | 'field';
  /** The path through containers, e.g. `Option<Vec<Pool>>`. */
  path: string;
}

/**
 * The abstract contract graph produced from a decoded spec.
 * Mirrors the future #482 `ContractGraph` shape.
 */
export interface ContractGraph {
  /** All nodes in the graph. */
  nodes: GraphNode[];
  /** All directed edges. */
  edges: GraphEdge[];
}

/**
 * Result of the worth-drawing decision.
 */
export type DiagramDecision =
  | { readonly kind: 'draw' }
  | { readonly kind: 'too-simple'; readonly reason: string }
  | { readonly kind: 'too-large'; readonly nodeCount: number };

/**
 * Maximum number of nodes after default grouping and collapsing
 * (#502) above which a diagram is considered too large.
 * Provisional — needs calibration against real contracts.
 */
export const MAX_NODES = 60;

/**
 * Minimum spec-derived edges for a diagram to be worth drawing.
 * A contract with zero edges (e.g. the registry) has nothing the
 * docs don't already say.
 */
export const MIN_EDGES = 0;

/**
 * Decides whether a contract's interface is worth drawing as a diagram.
 *
 * - `too-simple`: zero spec-derived edges. Once phase 2/3 overlays exist,
 *   a contract with overlay data (read/write marks, call edges) is still drawn.
 * - `too-large`: more than `MAX_NODES` after the default grouping and
 *   collapsing (#502).
 * - `draw`: otherwise.
 *
 * The `model` parameter (the laid-out `DiagramModel`) is accepted for
 * future use (e.g. measuring actual rendered size) but is not consulted
 * by the current logic.
 */
export function diagramDecision(
  graph: ContractGraph,
  _model: DiagramModel,
): DiagramDecision {
  // Too simple: no spec-derived edges. The registry has 8 functions, 0 types,
  // 0 edges — the docs already say everything.
  if (graph.edges.length <= MIN_EDGES) {
    return { kind: 'too-simple', reason: 'no spec-derived edges to draw' };
  }

  // Too large: more than MAX_NODES after grouping/collapsing.
  // For now we count all nodes; #502 will refine this to count after grouping.
  if (graph.nodes.length > MAX_NODES) {
    return { kind: 'too-large', nodeCount: graph.nodes.length };
  }

  return { kind: 'draw' };
}