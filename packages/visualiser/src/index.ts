/**
 * @file @signet/visualiser
 *
 * Pure, framework-free contract diagram core for Signet.
 *
 * Package Contract (§4.2 of docs/CONTRACT_VISUALISER_DESIGN.md):
 * - Pure core: graph, layout (`layoutContractGraph`), SVG string renderer and
 *   overlays live behind this entry point. No React and no DOM here — the
 *   tsconfig `lib` deliberately omits `DOM`, so any `window`/`document`
 *   reference fails `typecheck`.
 * - The `./interactive` entry holds the framework-free DOM enhancer (wired up
 *   in #500–#505); `./tokens.css` holds the design tokens (filled in by #491).
 *
 * Four consumers share this core: the web contract page, the local sandbox UI
 * served by `signet dev`, SVG export, and the Go CLI through an embedded JS
 * bundle (#544).
 */

import type { ContractSpec } from '@signet/spec';

export const VISUALISER_VERSION = '0.1.0';

export type { ContractSpec };

/** One node in a laid-out contract diagram. */
export interface DiagramNode {
  id: string;
  label: string;
}

/** One directed edge between two diagram nodes. */
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

/** The laid-out diagram model renderers consume. */
export interface DiagramModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** Options for the pure layout pass. */
export interface LayoutOptions {
  direction?: 'lr' | 'tb';
  /**
   * Nesting levels of user-defined types drawn inline before the diagram hands
   * a type off to its docs section as a stub (#490). Defaults to
   * `DEFAULT_TYPE_DEPTH`; `Infinity` expands the whole reachable graph.
   */
  typeDepth?: number;
  /** User-defined type names to open to their next level past `typeDepth`. */
  expandTypes?: string[];
}

/**
 * Pure pipeline signature: spec in, diagram model out. It composes the passes
 * below (`buildContractGraph`, then `layoutContractGraph`, then `routeDiagram`)
 * and lands with the wiring work (#500+); the type is declared here so every
 * consumer builds against one contract. `layoutContractGraph` itself takes the
 * abstract graph, not the spec.
 */
export type LayoutContractGraph = (spec: ContractSpec, options?: LayoutOptions) => DiagramModel;

// Deterministic orthogonal edge routing. Kept as a separate pure pass so the
// layered layout can assign nodes before resolving ports and channels.
export {
  routeDiagram,
  routeEdges,
  type Point,
  type RoutableEdge,
  type RoutableNode,
  type RouteOptions,
  type RoutedEdge,
} from './route.ts';

// Abstract contract graph (E-02): the layout's input.
export {
  buildContractGraph,
  functionNodeId,
  typeNodeId,
  type ContractGraph,
  type EdgeRole,
  type FunctionNode,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphNode,
  type MissingNode,
  type TypeNode,
} from './graph.ts';

// Layered column layout (E-06): graph in, positioned diagram out.
export {
  LAYOUT_VERSION,
  layoutContractGraph,
  type LayoutGeometryOptions,
  type PositionedDiagramModel,
  type PositionedEdge,
  type PositionedGroup,
  type PositionedNode,
} from './layout.ts';

// Deterministic text metrics (E-05): the layout's only measure of a label.
export { MIN_TEXT_PX, textCells, textWidth, truncateLabel } from './metrics.ts';

/** Pure SVG renderer (§4.2): DiagramModel -> SVG string. */
export { renderDiagramSvg, type RenderOptions } from './render.ts';

/** Worth-drawing decision (§3): draw / too-simple / too-large. */
export {
  type DecidableGraph,
  type DiagramDecision,
  MAX_NODES,
  MIN_EDGES,
  diagramDecision,
} from './decide.ts';

// Function grouping by name prefix (E-04): clusters a flat function list.
export {
  LIFECYCLE_GROUP,
  MIN_GROUP_SIZE,
  OTHER_GROUP,
  groupFunctions,
  type FunctionGroup,
} from './group.ts';

// Type-graph depth policy (E-10): which types a diagram draws inline.
export {
  DEFAULT_TYPE_DEPTH,
  buildTypeGraph,
  typeAnchor,
  type TypeGraph,
  type TypeGraphEdge,
  type TypeGraphEdgeRole,
  type TypeGraphNode,
  type TypeGraphOptions,
} from './type-graph.ts';

// Theme tokens and CSS variables (§2.3 of docs/CONTRACT_VISUALISER_DESIGN.md)
export {
  VIZ_CSS_VARIABLES,
  VIZ_DARK_TOKENS,
  VIZ_LIGHT_TOKENS,
  VIZ_TOKEN_NAMES,
  VIZ_TOKENS,
  formatTokenDeclarations,
  generateInlineTokensStyle,
  generateTokensCss,
  type VizTheme,
  type VizThemeTokens,
  type VizTokenName,
} from './tokens.ts';
