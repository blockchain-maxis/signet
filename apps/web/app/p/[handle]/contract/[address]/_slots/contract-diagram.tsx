import { fromSpecJson, type ContractSpec, type SpecJson } from '@signet/spec';
import {
  buildContractGraph,
  buildDiagramOutline,
  callersOnly,
  CALLEES_MORE_ID,
  diagramDecision,
  layoutContractGraph,
  renderDiagramSvg,
  renderOutlineHtml,
  typeAnchor,
  withMarks,
  MAX_NODES,
  type LayoutOverlays,
  type MutabilityOverlayInput,
  type PositionedDiagramModel,
} from '@signet/visualiser';
import { logger } from '@/lib/logger';
import { resolveNetwork, stellarExpertTxUrl } from '@/lib/network';
import { loadContractCallGraph, type ContractCallGraph } from '@/lib/server/call-graph-source';
import { getMutabilityOverlay, type MutabilityOverlay } from '@/lib/server/diagram';
import { SectionLabel } from '../../../_components/section-label';
import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/**
 * The decoded spec to draw from. The graph reads the flattened views, plus the raw
 * entries only to find error enums with no cases, so when the entries cannot be
 * decoded the views alone still give the diagram; this tab never throws (design §2.4).
 */
function specForGraph(json: SpecJson, { address, network }: ContractSlotProps): ContractSpec {
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

/**
 * Diagram slot (#450, #499).
 *
 * Renders the server-rendered SVG diagram with four states (draw, too-simple, too-large, error).
 * Following #499 (E-19), the outline sits after the SVG in a `<details>` labelled
 * "Diagram as text", and the SVG gets `aria-describedby="diagram-outline"`.
 */
function DiagramBody(
  props: ContractSlotProps & {
    calls: ContractCallGraph | null;
    mutability: MutabilityOverlay | null;
  },
) {
  if (props.spec.kind !== 'spec') {
    return <SlotPlaceholder slot="diagram" props={props} />;
  }

  const spec = specForGraph(props.spec.spec as SpecJson, props);
  const graph = buildContractGraph(spec);
  const specModel = layoutContractGraph(graph);
  const decision = diagramDecision(graph, specModel);

  // The call graph (#543) rides on the spec diagram; when the interface is not
  // worth drawing, the calls are drawn alone, from the functions that made them.
  const { calls } = props;
  const overlays: LayoutOverlays = calls
    ? {
        calls: {
          overlay: calls.overlay,
          labels: new Map([...calls.labels].map(([address, label]) => [address, label.text])),
          expand: props.expandCallees,
        },
      }
    : {};
  const callsAlone = decision.kind !== 'draw' && calls !== null;
  const model: PositionedDiagramModel =
    decision.kind === 'draw'
      ? layoutContractGraph(graph, {}, overlays)
      : callsAlone
        ? layoutContractGraph(callersOnly(graph, calls.overlay), {}, overlays)
        : specModel;

  const basePath = `/p/${encodeURIComponent(props.handle)}/contract/${encodeURIComponent(props.address)}`;
  const hrefForNode = (nodeId: string) => {
    const node = model.nodes.find((n) => n.id === nodeId);
    if (node?.kind === 'function') return `${basePath}/functions#fn-${node.name}`;
    if (node?.kind === 'type') return `${basePath}/types#${typeAnchor(node.name)}`;
    if (node?.kind === 'callee' && node.address)
      return calls?.labels.get(node.address)?.href ?? null;
    if (node?.id === CALLEES_MORE_ID) return `${basePath}/diagram?callees=all`;
    return null;
  };

  // Read/write marks (#512): observed from indexed transactions, stated as such
  // under the diagram, never taken from the interface.
  const { mutability } = props;
  const explorer = resolveNetwork(props.network).explorer;
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
  const writesOnly = Boolean(props.writesOnly && hasWrites);

  const outline = mutability
    ? withMarks(buildDiagramOutline(model), mutability.marks)
    : buildDiagramOutline(model);
  const outlineHtml = renderOutlineHtml(outline, hrefForNode);

  const outlineDetails = (
    <details
      id="diagram-outline"
      className="mt-8 border border-[#1f1d19] p-4 text-[13px] text-[#8a8779]"
      open={props.focus ? true : undefined}
    >
      <summary className="cursor-pointer font-medium text-[#f5f4ee] hover:text-[#e05a4b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]">
        Diagram as text
      </summary>
      <div className="mt-4" dangerouslySetInnerHTML={{ __html: outlineHtml }} />
    </details>
  );

  if (decision.kind === 'too-simple' && !callsAlone) {
    return (
      <section data-testid="slot-diagram">
        <SectionLabel as="h2">Diagram</SectionLabel>
        <p className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]">
          This contract’s interface has no types to connect. The function list below is the complete
          picture.
        </p>
        {outlineDetails}
      </section>
    );
  }

  if (decision.kind === 'too-large' && !callsAlone) {
    logger.warn(
      { address: props.address, limit: MAX_NODES, observed: decision.nodeCount },
      'spec.limit.exceeded',
    );
    return (
      <section data-testid="slot-diagram">
        <SectionLabel as="h2">Diagram</SectionLabel>
        <p className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]">
          This contract’s interface has {decision.nodeCount} nodes, which is too large to diagram
          usefully on one canvas.
        </p>
        {outlineDetails}
      </section>
    );
  }

  const query = props.query;
  const cleanQuery = query?.trim().toLowerCase();

  const svg = renderDiagramSvg(model, {
    idPrefix: `diagram-${props.address}-`,
    hrefForNode,
    title: `${props.handle} (${props.address})`,
    ariaDescribedBy: 'diagram-outline',
    query,
    focus: props.focus,
    writesOnly,
    ...(marks && { overlays: { mutability: marks } }),
  });

  const totalFunctions = model.nodes.filter((n) => n.id.startsWith('fn:')).length;
  const matchingFunctions = cleanQuery
    ? model.nodes.filter(
        (n) =>
          n.id.startsWith('fn:') &&
          (n.id.toLowerCase().includes(cleanQuery) || n.label.toLowerCase().includes(cleanQuery)),
      ).length
    : totalFunctions;

  const totalMatches = cleanQuery
    ? model.nodes.filter(
        (n) =>
          n.id.toLowerCase().includes(cleanQuery) || n.label.toLowerCase().includes(cleanQuery),
      ).length
    : model.nodes.length;

  const announcement =
    cleanQuery && cleanQuery.length > 0
      ? totalMatches === 0
        ? 'No functions or types match'
        : `${matchingFunctions} of ${totalFunctions} functions match`
      : '';

  return (
    <section data-testid="slot-diagram">
      <SectionLabel as="h2">Diagram</SectionLabel>
      <div className="mt-6 mb-4 flex flex-col gap-2">
        <form method="GET" className="flex items-center gap-3">
          <input
            type="search"
            name="q"
            defaultValue={query ?? ''}
            placeholder="Search functions or types..."
            className="viz-filter-input bg-[#181614] border border-[#2b2721] rounded px-3 py-1.5 text-xs text-[#f5f4ee] placeholder-[#8a8779] focus:outline-none focus:border-[#e05252] w-64"
            aria-label="Filter functions and types"
          />
          <label
            className={`flex items-center gap-2 text-xs ${hasWrites ? 'text-[#f5f4ee]' : 'text-[#8a8779]'}`}
            title={
              hasWrites
                ? undefined
                : 'No function of this contract has been seen writing, so there is nothing to filter on.'
            }
          >
            <input
              type="checkbox"
              name="writes"
              value="1"
              defaultChecked={writesOnly}
              disabled={!hasWrites}
              className="accent-[#e05a4b]"
            />
            Writes only
          </label>
          <button
            type="submit"
            className="rounded border border-[#2b2721] px-3 py-1.5 text-xs text-[#f5f4ee] hover:border-[#e05a4b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]"
          >
            Apply
          </button>
        </form>
        <div aria-live="polite" className="text-xs text-[#8a8779] sr-only">
          {announcement}
        </div>
      </div>
      {cleanQuery && totalMatches === 0 && (
        <p className="my-4 text-xs text-[#8a8779]">No functions or types match</p>
      )}
      {callsAlone && (
        <p className="mb-4 text-[13px] leading-[1.7] text-[#8a8779]">
          {decision.kind === 'too-large'
            ? `This contract’s interface has ${decision.nodeCount} nodes, too many to diagram on one canvas, so this shows only the calls it makes to other contracts.`
            : 'This contract’s interface has no types to connect, so this shows only the calls it makes to other contracts.'}
        </p>
      )}
      <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      {mutability?.reason && (
        <p className="mt-2 text-xs text-[#8a8779]">
          {mutability.reason} {mutability.retentionNote}
        </p>
      )}
      {outlineDetails}
    </section>
  );
}

/**
 * Bounded viewport container (#504): overflow: auto, max-height: 70vh, a
 * focusable `role="region"` so keyboard users can scroll a large diagram.
 */
export async function ContractDiagram(props: ContractSlotProps) {
  const [calls, mutability] =
    props.spec.kind === 'spec'
      ? await Promise.all([
          loadContractCallGraph(props.address, props.network),
          getMutabilityOverlay(props.address, props.network),
        ])
      : [null, null];
  return (
    <div
      role="region"
      aria-label="Contract diagram viewport"
      tabIndex={0}
      className="viz-viewport max-h-[70vh] max-w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-[#60a5fa]"
    >
      <DiagramBody {...props} calls={calls} mutability={mutability} />
    </div>
  );
}
