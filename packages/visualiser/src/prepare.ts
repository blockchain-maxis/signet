/**
 * @file Pure pipeline pass: build -> collapse -> layout -> decide (#946).
 *
 * Single point of entry for preparing a contract diagram across web,
 * standalone SVG export, and the Go CLI (`signet visualise`).
 */

import type { ContractSpec } from '@signet/spec';
import {
  canonicalExpand,
  collapseGroups,
  COLLAPSE_THRESHOLD,
  functionGroupsOf,
} from './collapse.ts';
import { diagramDecision, type DiagramDecision } from './decide.ts';
import { buildContractGraph, type ContractGraph } from './graph.ts';
import {
  layoutContractGraph,
  type LayoutOptions,
  type LayoutOverlays,
  type PositionedDiagramModel,
} from './layout.ts';

export interface PrepareDiagramOptions {
  /** Groups to draw expanded (#502, #946). Checked through {@link canonicalExpand}. */
  readonly expand?: string | readonly string[] | null;
  /** Layout options (direction, type depth, etc.). */
  readonly layoutOptions?: LayoutOptions;
  /** Layout overlays (call graph, activity counts). */
  readonly overlays?: LayoutOverlays;
  /** Custom layout function (e.g. for caching). Receives the collapsed graph and canonical expanded groups. */
  readonly layout?: (graph: ContractGraph, expanded: string[]) => PositionedDiagramModel;
}

export interface PreparedDiagram {
  readonly full: ContractGraph;
  readonly graph: ContractGraph;
  readonly model: PositionedDiagramModel;
  readonly decision: DiagramDecision;
  readonly expanded: string[];
  readonly collapsible: boolean;
}

/**
 * Prepares a diagram from a spec: builds the abstract graph, collapses groups,
 * lays out the graph, and makes the worth-drawing decision.
 */
export function prepareDiagram(
  spec: ContractSpec,
  options: PrepareDiagramOptions = {},
): PreparedDiagram {
  const full = buildContractGraph(spec);
  const expanded = canonicalExpand(options.expand ?? null, full);
  const graph = collapseGroups(full, { expand: expanded });
  const collapsible =
    full.nodes.filter((n) => n.kind === 'function').length > COLLAPSE_THRESHOLD &&
    functionGroupsOf(full).some((g) => g.functions.length > 1);
  const model = options.layout
    ? options.layout(graph, expanded)
    : layoutContractGraph(graph, options.layoutOptions, options.overlays);
  const decision = diagramDecision(graph, model);
  return { full, graph, model, decision, expanded, collapsible };
}
