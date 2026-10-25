import {
  renderStorageOutlineHtml,
  renderStorageSvg,
  typeAnchor,
  MAX_NODES,
  type StorageViewInput,
} from '@signet/visualiser';
import type { SpecJson } from '@signet/spec';
import { logger } from '@/lib/logger';
import { loadContractCallGraph, type ContractCallGraph } from '@/lib/server/call-graph-source';
import {
  getInstanceStorage,
  getMutabilityOverlay,
  getStorageObservations,
  type InstanceStorage,
  type MutabilityOverlay,
} from '@/lib/server/diagram';
import { diagramPath, drawContractDiagram } from '@/lib/server/diagram-view';
import { DiagramExpand } from './diagram-expand';
import { StorageToggle } from './storage-toggle';
import { SectionLabel } from '../../../_components/section-label';
import { SlotPlaceholder } from './slot-placeholder';
import type { ContractSlotProps } from './slot-props';

/** The part of the tab the expand enhancer (#502) swaps in place. */
const DIAGRAM_REGION_ID = 'diagram-region';

/**
 * Diagram slot (#450, #499).
 *
 * Renders the server-rendered SVG diagram with four states (draw, too-simple, too-large, error).
 * Following #499 (E-19), the outline sits after the SVG in a `<details>` labelled
 * "Diagram as text", and the SVG gets `aria-describedby="diagram-outline"`. The
 * drawing itself is `drawContractDiagram`, shared with the fragment route (#502).
 */
function DiagramBody(
  props: ContractSlotProps & {
    calls: ContractCallGraph | null;
    mutability: MutabilityOverlay | null;
    /** The storage view's text, appended to the outline (#515). */
    storageOutline: string | null;
  },
) {
  if (props.spec.kind !== 'spec') {
    return <SlotPlaceholder slot="diagram" props={props} />;
  }

  const view = drawContractDiagram({
    handle: props.handle,
    address: props.address,
    network: props.network,
    spec: props.spec.spec as SpecJson,
    calls: props.calls,
    mutability: props.mutability,
    query: props.query,
    focus: props.focus,
    expandCallees: props.expandCallees,
    writesOnly: props.writesOnly,
    expand: props.expand,
  });
  const { decision, callsAlone, hasWrites, writesOnly } = view;
  const { mutability } = props;

  const outlineDetails = (
    <details
      id="diagram-outline"
      className="mt-8 border border-[#1f1d19] p-4 text-[13px] text-[#8a8779]"
      open={props.focus ? true : undefined}
    >
      <summary className="cursor-pointer font-medium text-[#f5f4ee] hover:text-[#e05a4b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e05a4b]">
        Diagram as text
      </summary>
      <div className="mt-4" dangerouslySetInnerHTML={{ __html: view.outlineHtml }} />
      {props.storageOutline && (
        <div className="mt-6" dangerouslySetInnerHTML={{ __html: props.storageOutline }} />
      )}
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
  const announcement =
    cleanQuery && cleanQuery.length > 0
      ? view.totalMatches === 0
        ? 'No functions or types match'
        : `${view.matchingFunctions} of ${view.totalFunctions} functions match`
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
          {view.expanded.length > 0 && (
            <input type="hidden" name="expand" value={view.expanded.join(',')} />
          )}
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
      {cleanQuery && view.totalMatches === 0 && (
        <p className="my-4 text-xs text-[#8a8779]">No functions or types match</p>
      )}
      {callsAlone && (
        <p className="mb-4 text-[13px] leading-[1.7] text-[#8a8779]">
          {decision.kind === 'too-large'
            ? `This contract’s interface has ${decision.nodeCount} nodes, too many to diagram on one canvas, so this shows only the calls it makes to other contracts.`
            : 'This contract’s interface has no types to connect, so this shows only the calls it makes to other contracts.'}
        </p>
      )}
      <div id={DIAGRAM_REGION_ID} dangerouslySetInnerHTML={{ __html: view.regionHtml }} />
      {view.collapsible && (
        <DiagramExpand
          region={DIAGRAM_REGION_ID}
          fragmentPath={`${diagramPath(props.handle, props.address)}/fragment`}
        />
      )}
      {mutability?.reason && (
        <p className="mt-2 text-xs text-[#8a8779]">
          {mutability.reason} {mutability.retentionNote}
        </p>
      )}
      {outlineDetails}
    </section>
  );
}

const STORAGE_VIEW_ID = 'storage-view';

/** The instance read (#514) as the storage view states it. */
function instanceView(storage: InstanceStorage): StorageViewInput['instance'] {
  return storage.status === 'ok'
    ? { ledger: storage.ledger, entries: storage.entries }
    : { ledger: storage.ledger, reason: storage.reason };
}

/**
 * Bounded viewport container (#504): overflow: auto, max-height: 70vh, a
 * focusable `role="region"` so keyboard users can scroll a large diagram.
 */
export async function ContractDiagram(props: ContractSlotProps) {
  const [calls, mutability, observed] =
    props.spec.kind === 'spec'
      ? await Promise.all([
          loadContractCallGraph(props.address, props.network),
          getMutabilityOverlay(props.address, props.network, { wasmHash: props.wasmHash }),
          getStorageObservations(props.address, props.network, { wasmHash: props.wasmHash }),
        ])
      : [null, null, null];

  // The storage view (#515): only with observations, since the instance
  // entry alone is not what this view is about; the RPC is read only then.
  const hasStorage = observed !== null && observed.observations > 0;
  const storage: StorageViewInput | null = hasStorage
    ? {
        ...observed,
        instance: instanceView(await getInstanceStorage(props.address, props.network)),
      }
    : null;
  const basePath = `/p/${encodeURIComponent(props.handle)}/contract/${encodeURIComponent(props.address)}`;
  const hrefForType = (name: string) => `${basePath}/types#${typeAnchor(name)}`;
  const storageOn = hasStorage && (props.focus?.startsWith('slot:') || props.storage !== false);

  return (
    <>
      <div
        role="region"
        aria-label="Contract diagram viewport"
        tabIndex={0}
        className="viz-viewport max-h-[70vh] max-w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-[#60a5fa]"
      >
        <DiagramBody
          {...props}
          calls={calls}
          mutability={mutability}
          storageOutline={storage ? renderStorageOutlineHtml(storage, hrefForType) : null}
        />
      </div>
      {props.spec.kind === 'spec' && (
        <section className="mt-10" aria-label="Storage" data-testid="slot-storage">
          <div className="mb-4 flex flex-wrap items-center gap-6">
            <SectionLabel>Storage</SectionLabel>
            <StorageToggle
              controls={STORAGE_VIEW_ID}
              initiallyOn={storageOn}
              disabledReason={
                hasStorage
                  ? undefined
                  : 'No calls to this contract have been observed, so there is no storage to show.'
              }
            />
          </div>
          {storage && (
            <div id={STORAGE_VIEW_ID} hidden={!storageOn}>
              <a
                href={`${basePath}/diagram.svg?view=storage&theme=auto`}
                className="mb-3 inline-block text-xs underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
                download
              >
                Download storage SVG
              </a>
              <div
                role="region"
                aria-label="Storage view viewport"
                tabIndex={0}
                className="viz-viewport max-h-[70vh] max-w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-[#60a5fa]"
                dangerouslySetInnerHTML={{
                  __html: renderStorageSvg(storage, {
                    idPrefix: `storage-${props.address}-`,
                    title: `${props.handle} (${props.address}) storage, observed`,
                    hrefForType,
                    hrefForFunction: (name) => `${basePath}/functions#fn-${name}`,
                    ...(props.focus?.startsWith('slot:') && { focus: props.focus }),
                  }),
                }}
              />
            </div>
          )}
        </section>
      )}
    </>
  );
}
