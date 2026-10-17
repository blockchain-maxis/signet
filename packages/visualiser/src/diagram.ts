/**
 * @file Spec → positioned diagram composition (#502).
 *
 * The pure passes each do one thing: `buildContractGraph` derives the graph,
 * `limitTypeDepth` applies the type-graph depth policy (#490), and
 * `layoutContractGraph` positions what is left. This module is the one place
 * that composes them for a decoded spec, so the page, a fragment route and a
 * test all build the same diagram from the same options.
 *
 * The default collapse policy lives here rather than in the layout: a contract
 * with more than `COLLAPSE_THRESHOLD` functions starts with every group
 * collapsed, so a 49-function router opens as a handful of readable nodes
 * instead of a wall. `LayoutOptions.collapsedGroups` names an explicit set
 * (which the server derives from `?expand=`) and turns the threshold off.
 */

import type { ContractSpec } from '@signet/spec';
import { buildContractGraph } from './graph.ts';
import type { FunctionGroup } from './group.ts';
import { groupFunctions } from './group.ts';
import type { LayoutGeometryOptions, PositionedDiagramModel } from './layout.ts';
import { layoutContractGraph } from './layout.ts';
import type { LayoutOptions } from './index.ts';
import { limitTypeDepth } from './type-depth.ts';

/**
 * Function count above which every group starts collapsed. Provisional, like
 * the diagram's size ceiling: it is the point where 40-odd flat labels stop
 * being scannable.
 */
export const COLLAPSE_THRESHOLD = 25;

/** Names of the groups that collapse under the default policy. */
export function defaultCollapsedGroups(
  functionNames: readonly string[],
  threshold: number = COLLAPSE_THRESHOLD,
): string[] {
  if (functionNames.length <= threshold) return [];
  return groupFunctions(functionNames).map((group: FunctionGroup) => group.name);
}

/**
 * Build the positioned diagram for a spec.
 *
 * `expandTypes` opens named type stubs one level past `typeDepth`, and
 * `collapsedGroups` names the groups drawn as one node. When the caller does
 * not name collapsed groups, a contract above `collapseThreshold` collapses
 * all of them; below it, none.
 */
export function layoutContractDiagram(
  spec: ContractSpec,
  options: LayoutOptions = {},
): PositionedDiagramModel {
  const graph = buildContractGraph(spec);
  const limited = limitTypeDepth(graph, {
    typeDepth: options.typeDepth,
    expandTypes: options.expandTypes,
  });
  const functionNames = graph.nodes
    .filter((node) => node.kind === 'function')
    .map((node) => node.name);
  const collapsed =
    options.collapsedGroups ??
    defaultCollapsedGroups(functionNames, options.collapseThreshold ?? COLLAPSE_THRESHOLD);
  const geometry: LayoutGeometryOptions = {
    ...options,
    collapsedGroups: collapsed,
  };
  return layoutContractGraph(limited, geometry);
}
