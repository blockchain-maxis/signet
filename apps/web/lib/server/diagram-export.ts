import { fromSpecJson } from '@signet/spec';
import {
  buildContractGraph,
  layoutContractGraph,
  renderStandaloneSvg,
  MAX_NODES,
} from '@signet/visualiser';
import { normalizeNetwork } from '@signet/types';
import { attributeContract } from '../contract-attribution.ts';
import { loadContractSpec } from './contract-spec.ts';
import { logger } from '../logger.ts';

export interface DiagramExportDeps {
  attribute: typeof attributeContract;
  loadSpec: typeof loadContractSpec;
}

/** Route handlers do not run page layouts: repeat the attribution gate before loading any spec. */
export async function exportContractDiagram(
  request: Request,
  params: { handle: string; address: string },
  deps: DiagramExportDeps = { attribute: attributeContract, loadSpec: loadContractSpec },
): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const attribution = await deps.attribute(params.handle, params.address);
  if (attribution.status === 'invalid' || attribution.status === 'not-attributed') {
    return new Response('Contract not found', { status: 404, headers });
  }
  if (attribution.status === 'unavailable')
    return new Response('Attribution unavailable', { status: 503, headers });
  const theme = new URL(request.url).searchParams.get('theme') ?? 'auto';
  if (theme !== 'dark' && theme !== 'light' && theme !== 'auto') {
    return new Response('Invalid theme', { status: 400, headers });
  }
  const { address, wasmHash } = attribution.contract;
  const network = normalizeNetwork(attribution.contract.network);
  const result = await deps.loadSpec({ address, network, wasmHash });
  if (!result.ok) return new Response('Contract interface unavailable', { status: 503, headers });
  try {
    // #497 will cache this pure layout by (wasmHash, layoutVersion). Reuse the
    // canonical spec resolver now; do not create a competing layout cache.
    const graph = buildContractGraph(fromSpecJson(result.spec));
    if (graph.nodes.length > MAX_NODES)
      return new Response('Diagram too large to export', { status: 422, headers });
    const svg = renderStandaloneSvg(layoutContractGraph(graph), {
      theme,
      provenance: { address, network, wasmHash: result.wasmHash },
    });
    return new Response(svg, {
      headers: {
        ...headers,
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="signet-${address}-${theme}.svg"`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch {
    logger.warn({ address, network }, 'standalone diagram export failed');
    return new Response('Diagram unavailable', { status: 503, headers });
  }
}
