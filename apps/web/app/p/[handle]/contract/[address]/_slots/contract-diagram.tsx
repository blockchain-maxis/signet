import { fromSpecJson, type ContractSpec, type SpecJson } from '@signet/spec';
import {
  buildContractGraph,
  buildDiagramOutline,
  diagramDecision,
  layoutContractGraph,
  renderDiagramSvg,
  renderOutlineHtml,
  typeAnchor,
} from '@signet/visualiser';
import { logger } from '@/lib/logger';
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
function DiagramBody(props: ContractSlotProps) {
  if (props.spec.kind !== 'spec') {
    return <SlotPlaceholder slot="diagram" props={props} />;
  }

  const spec = specForGraph(props.spec.spec as SpecJson, props);
  const graph = buildContractGraph(spec);
  const model = layoutContractGraph(graph);
  const decision = diagramDecision(graph, model);

  const basePath = `/p/${encodeURIComponent(props.handle)}/contract/${encodeURIComponent(props.address)}`;
  const hrefForNode = (nodeId: string) => {
    const node = model.nodes.find((n) => n.id === nodeId);
    if (node?.kind === 'function') return `${basePath}/functions#fn-${node.name}`;
    if (node?.kind === 'type') return `${basePath}/types#${typeAnchor(node.name)}`;
    return null;
  };

  const outline = buildDiagramOutline(model);
  const outlineHtml = renderOutlineHtml(outline, hrefForNode);

  const outlineDetails = (
    <details
      id="diagram-outline"
      className="mt-8 border border-[#1f1d19] p-4 text-[13px] text-[#8a8779]"
    >
      <summary className="cursor-pointer font-medium text-[#f5f4ee] hover:text-[#e05a4b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]">
        Diagram as text
      </summary>
      <div
        className="mt-4"
        dangerouslySetInnerHTML={{ __html: outlineHtml }}
      />
    </details>
  );

  if (decision.kind === 'too-simple') {
    return (
      <section data-testid="slot-diagram">
        <SectionLabel as="h2">Diagram</SectionLabel>
        <p className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]">
          This contract’s interface has no types to connect. The function list below is the complete picture.
        </p>
        {outlineDetails}
      </section>
    );
  }

  if (decision.kind === 'too-large') {
    return (
      <section data-testid="slot-diagram">
        <SectionLabel as="h2">Diagram</SectionLabel>
        <p className="mt-6 text-[13px] leading-[1.7] text-[#8a8779]">
          This contract’s interface has {model.nodes.length} nodes, which is too large to diagram usefully on one canvas.
        </p>
        {outlineDetails}
      </section>
    );
  }

  const svg = renderDiagramSvg(model, {
    idPrefix: `diagram-${props.address}-`,
    hrefForNode,
    title: `${props.handle} (${props.address})`,
    ariaDescribedBy: 'diagram-outline',
  });

  return (
    <section data-testid="slot-diagram">
      <SectionLabel as="h2">Diagram</SectionLabel>
      <div
        className="mt-6 overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {outlineDetails}
    </section>
  );
}

/**
 * Bounded viewport container (#504): overflow: auto, max-height: 70vh, a
 * focusable `role="region"` so keyboard users can scroll a large diagram.
 */
export function ContractDiagram(props: ContractSlotProps) {
  return (
    <div
      role="region"
      aria-label="Contract diagram viewport"
      tabIndex={0}
      className="viz-viewport max-h-[70vh] max-w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-[#60a5fa]"
    >
      <DiagramBody {...props} />
    </div>
  );
}
