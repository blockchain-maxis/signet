/**
 * @file Diagram worth-drawing decision (#489, design §3).
 *
 * The registry (8 functions, no types, no edges) shouldn't be drawn because
 * the docs already say everything a diagram could. Above ~60 nodes after
 * grouping, a diagram becomes a picture nobody can read. This module exports
 * one explicit decision function so the thresholds live in one place and can
 * be recalibrated.
 *
 * The decision takes any {@link DecidableGraph}; the `ContractGraph` built by
 * `buildContractGraph` (#482, `src/graph.ts`) satisfies it.
 */

import type { DiagramModel } from './index.ts';

/**
 * The slice of the abstract contract graph the decision reads: only how many
 * nodes and edges there are. Structural, so the real `ContractGraph` from
 * `./graph.ts` satisfies it without this module depending on its shape.
 */
export interface DecidableGraph {
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
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
export function diagramDecision(graph: DecidableGraph, _model: DiagramModel): DiagramDecision {
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
