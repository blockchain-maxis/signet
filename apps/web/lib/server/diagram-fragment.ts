/**
 * @file The Diagram tab's fragment handler (#502).
 *
 * Route handlers do not run page layouts, so this repeats the attribution gate
 * before loading any interface. It lives outside `route.ts` so the statuses,
 * headers and query handling are testable with injected seams; the route file
 * is only Next's wiring.
 *
 * The response is the same `<svg>` the page inlines, built by the same
 * `renderContractDiagram` path. That equality is what makes the client
 * enhancer's in-place swap indistinguishable from a navigation.
 */

import { normalizeNetwork } from '@signet/types';
import { attributeContract } from '../contract-attribution.ts';
import { diagramNamesFromSpec, parseDiagramState } from '../diagram-state.ts';
import { renderContractDiagram } from './contract-diagram.ts';
import { loadContractSpec } from './contract-spec.ts';

const HEADERS = {
  'Cache-Control': 'private, max-age=60',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

export interface DiagramFragmentDeps {
  attribute: typeof attributeContract;
  loadSpec: typeof loadContractSpec;
}

const DEFAULT_DEPS: DiagramFragmentDeps = {
  attribute: attributeContract,
  loadSpec: loadContractSpec,
};

/** Serve the server-rendered diagram fragment for one contract and state. */
export async function serveDiagramFragment(
  request: Request,
  params: { handle: string; address: string },
  deps: DiagramFragmentDeps = DEFAULT_DEPS,
): Promise<Response> {
  const { handle, address } = params;
  const attribution = await deps.attribute(handle, address);
  if (attribution.status === 'invalid' || attribution.status === 'not-attributed') {
    return new Response('Contract not found', { status: 404, headers: HEADERS });
  }
  if (attribution.status === 'unavailable') {
    return new Response('Attribution unavailable', { status: 503, headers: HEADERS });
  }

  const network = normalizeNetwork(attribution.contract.network);
  const result = await deps.loadSpec({
    address: attribution.contract.address,
    network,
    wasmHash: attribution.contract.wasmHash,
  });
  if (!result.ok) {
    return new Response('Contract interface unavailable', { status: 503, headers: HEADERS });
  }

  const names = diagramNamesFromSpec(result.spec);
  const state = parseDiagramState(new URL(request.url).searchParams, names);
  const contractBase = `/p/${encodeURIComponent(handle)}/contract/${encodeURIComponent(address)}`;
  const rendered = renderContractDiagram({
    spec: result.spec,
    names,
    state,
    contractBase,
    diagramPath: `${contractBase}/diagram`,
    wasmHash: result.wasmHash,
    title: `${address} contract interface`,
  });
  if (!rendered.ok) {
    return new Response('Diagram unavailable', { status: 503, headers: HEADERS });
  }
  return new Response(rendered.svg, {
    headers: { ...HEADERS, 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
}
