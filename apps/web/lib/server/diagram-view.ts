/**
 * @file apps/web/lib/server/diagram-view.ts
 *
 * The contract diagram as the Diagram tab draws it: graph, collapsed groups
 * (#502), overlays, layout and SVG, as strings. The page and the fragment
 * route (`.../diagram/fragment`) both draw through here, so a diagram
 * swapped in place by the client is the same markup a full page load gives.
 *
 * Pure apart from the warning logged when the spec entries do not decode.
 */

import { fromSpecJson, type ContractSpec, type SpecJson } from '@signet/spec';
import {
  buildContractGraph,
  buildDiagramOutline,
  callersOnly,
  canonicalExpand,
  CALLEES_MORE_ID,
  collapseGroups,
  diagramDecision,
  functionGroupsOf,
  layoutContractGraph,
  renderDiagramSvg,
  renderOutlineHtml,
  typeAnchor,
  withMarks,
  COLLAPSE_THRESHOLD,
  LAYOUT_VERSION,
  type DiagramDecision,
  type LayoutOverlays,
  type MutabilityOverlayInput,
  type PositionedDiagramModel,
} from '@signet/visualiser';
import type { Network } from '@signet/types';
import { logger } from '../logger.ts';
import { resolveNetwork, stellarExpertTxUrl } from '../network.ts';
import type { ContractCallGraph } from './call-graph-source.ts';
import type { MutabilityOverlay } from './diagram.ts';

export interface DiagramViewInput {
  readonly handle: string;
  readonly address: string;
  readonly network: Network;
  readonly spec: SpecJson;
  readonly calls: ContractCallGraph | null;
  readonly mutability: MutabilityOverlay | null;
  readonly query?: string;
  readonly focus?: string;
  readonly expandCallees?: boolean;
  readonly writesOnly?: boolean;
  /** The raw `?expand=` list; checked against the spec's group names. */
  readonly expand?: string | null;
}

export interface DiagramView {
  readonly decision: DiagramDecision;
  /** The interface is not drawn, only the calls the contract makes. */
  readonly callsAlone: boolean;
  readonly model: PositionedDiagramModel;
  readonly outlineHtml: string;
  readonly hasWrites: boolean;
  readonly writesOnly: boolean;
  /** Groups drawn expanded, canonical (sorted, known names only). */
  readonly expanded: readonly string[];
  /** Whether this contract has enough functions for its groups to collapse. */
  readonly collapsible: boolean;
  readonly totalFunctions: number;
  readonly matchingFunctions: number;
  readonly totalMatches: number;
  /**
   * The SVG and the expanded groups' collapse links, the part of the tab
   * the client swaps in place. Empty when the decision is not to draw.
   */
  readonly regionHtml: string;
}

/**
 * The decoded spec to draw from. The graph reads the flattened views, plus the raw
 * entries only to find error enums with no cases, so when the entries cannot be
 * decoded the views alone still give the diagram; this tab never throws (design §2.4).
 */
function specForGraph(json: SpecJson, address: string, network: string): ContractSpec {
  try {
    return fromSpecJson(json);
  } catch (err) {
    logger.warn(
      { address, network, errorMessage: err instanceof Error ? err.message : String(err) },
      'diagram: spec entries not decodable, using flattened views',
    );
    return { ...json, entries: [] } as unknown as ContractSpec;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The Diagram tab's path. */
export function diagramPath(handle: string, address: string): string {
  return `/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}/diagram`;
}

/**
 * The tab's URL for a set of expanded groups, keeping the other state. The
 * list is sorted, so the same state is always the same URL.
 */
export function diagramStateHref(
  input: Pick<DiagramViewInput, 'handle' | 'address' | 'query' | 'writesOnly' | 'expandCallees'>,
  expand: readonly string[],
): string {
  const params = new URLSearchParams();
  if (expand.length) params.set('expand', [...expand].sort().join(','));
  if (input.query) params.set('q', input.query);
  if (input.writesOnly) params.set('writes', '1');
  if (input.expandCallees) params.set('callees', 'all');
  const query = params.toString();
  return `${diagramPath(input.handle, input.address)}${query ? `?${query}` : ''}`;
}

/** Spec-only layouts by (wasmHash, layoutVersion, expanded groups): one entry per state. */
const layoutCache = new Map<string, PositionedDiagramModel>();
const LAYOUT_CACHE_SIZE = 200;

export function __resetDiagramViewCache(): void {
  layoutCache.clear();
}

function cachedLayout(key: string, compute: () => PositionedDiagramModel): PositionedDiagramModel {
  const hit = layoutCache.get(key);
  if (hit) {
    layoutCache.delete(key);
    layoutCache.set(key, hit);
    return hit;
  }
  const model = compute();
  layoutCache.set(key, model);
  while (layoutCache.size > LAYOUT_CACHE_SIZE) layoutCache.delete(layoutCache.keys().next().value!);
  return model;
}

/** Draws the Diagram tab's diagram for one URL state. */
export function drawContractDiagram(input: DiagramViewInput): DiagramView {
  const spec = specForGraph(input.spec, input.address, input.network);
  const full = buildContractGraph(spec);
  const expanded = canonicalExpand(input.expand ?? null, full);
  const graph = collapseGroups(full, { expand: expanded });
  const collapsible =
    full.nodes.filter((n) => n.kind === 'function').length > COLLAPSE_THRESHOLD &&
    functionGroupsOf(full).some((g) => g.functions.length > 1);
  const stateKey = `${input.spec.wasmHash}:${LAYOUT_VERSION}:${expanded.join(',')}`;
  const specModel = cachedLayout(stateKey, () => layoutContractGraph(graph));
  const decision = diagramDecision(graph, specModel);

  // The call graph (#543) rides on the spec diagram; when the interface is not
  // worth drawing, the calls are drawn alone, from the functions that made them.
  const { calls } = input;
  const overlays: LayoutOverlays = calls
    ? {
        calls: {
          overlay: calls.overlay,
          labels: new Map([...calls.labels].map(([address, label]) => [address, label.text])),
          expand: input.expandCallees,
        },
      }
    : {};
  const callsAlone = decision.kind !== 'draw' && calls !== null;
  const model: PositionedDiagramModel =
    decision.kind === 'draw'
      ? calls
        ? layoutContractGraph(graph, {}, overlays)
        : specModel
      : callsAlone
        ? layoutContractGraph(callersOnly(graph, calls.overlay), {}, overlays)
        : specModel;

  const basePath = `/p/${encodeURIComponent(input.handle)}/contract/${encodeURIComponent(input.address)}`;
  const hrefForNode = (nodeId: string) => {
    const node = model.nodes.find((n) => n.id === nodeId);
    if (node?.collapsed) return diagramStateHref(input, [...expanded, node.collapsed.group]);
    if (node?.kind === 'function') return `${basePath}/functions#fn-${node.name}`;
    if (node?.kind === 'type') return `${basePath}/types#${typeAnchor(node.name)}`;
    if (node?.kind === 'callee' && node.address)
      return calls?.labels.get(node.address)?.href ?? null;
    if (node?.id === CALLEES_MORE_ID) return `${basePath}/diagram?callees=all`;
    return null;
  };

  // Read/write marks (#512): observed from indexed transactions, stated as such
  // under the diagram, never taken from the interface.
  const { mutability } = input;
  const explorer = resolveNetwork(input.network).explorer;
  const marks: MutabilityOverlayInput | undefined = mutability
    ? {
        marks: mutability.marks,
        transactions: mutability.observations,
        firstLedger: mutability.firstLedger,
        lastLedger: mutability.lastLedger,
        staleObservations: mutability.staleObservations,
        txHref: (hash) => stellarExpertTxUrl(hash, explorer),
      }
    : undefined;
  const hasWrites = mutability
    ? Object.values(mutability.marks).some((m) => m.kind === 'writes')
    : false;
  const writesOnly = Boolean(input.writesOnly && hasWrites);

  const outline = mutability
    ? withMarks(buildDiagramOutline(model), mutability.marks)
    : buildDiagramOutline(model);
  const outlineHtml = renderOutlineHtml(outline, hrefForNode);

  const cleanQuery = input.query?.trim().toLowerCase();
  const isFunction = (n: PositionedDiagramModel['nodes'][number]) => n.id.startsWith('fn:');
  const matches = (n: PositionedDiagramModel['nodes'][number]) =>
    !cleanQuery || n.id.toLowerCase().includes(cleanQuery) || n.label.toLowerCase().includes(cleanQuery);
  const totalFunctions = model.nodes.filter(isFunction).length;
  const matchingFunctions = model.nodes.filter((n) => isFunction(n) && matches(n)).length;
  const totalMatches = model.nodes.filter(matches).length;

  let regionHtml = '';
  if (decision.kind === 'draw' || callsAlone) {
    const svg = renderDiagramSvg(model, {
      idPrefix: `diagram-${input.address}-`,
      hrefForNode,
      title: `${input.handle} (${input.address})`,
      ariaDescribedBy: 'diagram-outline',
      query: input.query,
      focus: input.focus,
      writesOnly,
      ...(marks && { overlays: { mutability: marks } }),
    });
    // Each expanded group gets a link that collapses it again (#502).
    const collapseLinks = expanded
      .map(
        (group) =>
          `<a href="${escapeHtml(diagramStateHref(input, expanded.filter((g) => g !== group)))}" data-group-toggle="${escapeHtml(group)}" class="rounded border border-[#2b2721] px-2 py-1 text-[#f5f4ee] hover:border-[#e05a4b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]">Collapse ${escapeHtml(group)}</a>`,
      )
      .join('');
    const controls = collapsible
      ? `<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-[#8a8779]" data-group-controls=""><span>${
          expanded.length
            ? `${expanded.length} group${expanded.length === 1 ? '' : 's'} expanded.`
            : 'Function groups are collapsed: select one to draw its functions.'
        }</span>${collapseLinks}</div>`
      : '';
    regionHtml = `${controls}<div class="overflow-x-auto">${svg}</div>`;
  }

  return {
    decision,
    callsAlone,
    model,
    outlineHtml,
    hasWrites,
    writesOnly,
    expanded,
    collapsible,
    totalFunctions,
    matchingFunctions,
    totalMatches,
    regionHtml,
  };
}
