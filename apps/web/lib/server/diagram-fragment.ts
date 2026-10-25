import { normalizeNetwork } from '@signet/types';
import { attributeContract } from '../contract-attribution.ts';
import { loadContractCallGraph } from './call-graph-source.ts';
import { loadContractSpec } from './contract-spec.ts';
import { getMutabilityOverlay } from './diagram.ts';
import { drawContractDiagram } from './diagram-view.ts';

export interface DiagramFragmentDeps {
  attribute: typeof attributeContract;
  loadSpec: typeof loadContractSpec;
  loadCalls: typeof loadContractCallGraph;
  loadMutability: typeof getMutabilityOverlay;
}

const DEFAULT_DEPS: DiagramFragmentDeps = {
  attribute: attributeContract,
  loadSpec: loadContractSpec,
  loadCalls: loadContractCallGraph,
  loadMutability: getMutabilityOverlay,
};

/**
 * The Diagram tab's drawn region for one URL state (#502): what the expand
 * enhancer swaps in place, drawn by the same `drawContractDiagram` as the
 * page. Route handlers do not run page layouts, so the attribution gate is
 * repeated here before any spec is loaded. Anything but a drawn diagram is
 * an error status, and the client then follows the link instead.
 */
export async function exportDiagramFragment(
  request: Request,
  params: { handle: string; address: string },
  deps: DiagramFragmentDeps = DEFAULT_DEPS,
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const attribution = await deps.attribute(params.handle, params.address);
  if (attribution.status === 'invalid' || attribution.status === 'not-attributed') {
    return new Response('Contract not found', { status: 404, headers });
  }
  if (attribution.status === 'unavailable') {
    return new Response('Attribution unavailable', { status: 503, headers });
  }
  const { address, wasmHash } = attribution.contract;
  const network = normalizeNetwork(attribution.contract.network);
  const spec = await deps.loadSpec({ address, network, wasmHash });
  if (!spec.ok) return new Response('Contract interface unavailable', { status: 503, headers });
  const [calls, mutability] = await Promise.all([
    deps.loadCalls(address, network),
    deps.loadMutability(address, network, { wasmHash }),
  ]);
  const query = new URL(request.url).searchParams;
  const view = drawContractDiagram({
    handle: params.handle,
    address,
    network,
    spec: spec.spec,
    calls,
    mutability,
    query: query.get('q') ?? undefined,
    focus: query.get('focus') ?? undefined,
    expandCallees: query.get('callees') === 'all',
    writesOnly: query.get('writes') === '1',
    expand: query.get('expand'),
  });
  if (!view.regionHtml) return new Response('No diagram drawn', { status: 409, headers });
  return new Response(view.regionHtml, {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}
