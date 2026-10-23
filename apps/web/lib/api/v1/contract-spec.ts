import {
  ContractNotFound,
  InterfaceUnreadable,
  InvalidWasm,
  LruSpecCache,
  NoInterface,
  RpcUnavailable,
  WasmNotFound,
  toSpecJson,
  type SpecJson,
} from '@signet/spec';
import { fetchContractSpecByHash, fetchWasmHash, type FetchOptions } from '@signet/spec/fetch';
import { ALLOW_HTTP, SOROBAN_RPC_URL, STELLAR_NETWORK } from '../../chain.ts';
import { fail, ok, parseAddress, V1Error, withV1 } from './http.ts';

const ADDRESS_CACHE = 'public, max-age=300, s-maxage=3600';
const HASH_CACHE = 'public, max-age=31536000, immutable';

/** Shared-reader seams keep route tests entirely offline. */
export interface ContractSpecApiDeps {
  fetchHash?: typeof fetchWasmHash;
  fetchSpec?: typeof fetchContractSpecByHash;
  options?: FetchOptions;
}

function matchesEtag(header: string | null, etag: string): boolean {
  // If-None-Match uses weak comparison for GET, including lists and '*'.
  return (
    header?.split(',').some((tag) => {
      const value = tag.trim();
      return value === '*' || value.replace(/^W\//, '') === etag;
    }) ?? false
  );
}

function specError(error: unknown): Response {
  if (error instanceof ContractNotFound) {
    return fail('not_found', 'Contract not found.', { reason: 'no_contract' });
  }
  if (error instanceof WasmNotFound) {
    return fail('not_found', 'WASM not found.', { reason: 'no_wasm' });
  }
  if (error instanceof NoInterface) {
    return fail('not_found', 'Contract has no embedded specification.', {
      reason: 'no_embedded_spec',
    });
  }
  if (
    error instanceof RpcUnavailable ||
    error instanceof InterfaceUnreadable ||
    error instanceof InvalidWasm
  ) {
    return fail('unavailable', 'Contract specification is unavailable.', { reason: error.kind });
  }
  throw error; // withV1 safely maps unexpected failures; never cache them.
}

export function createContractSpecApi(deps: ContractSpecApiDeps = {}) {
  // Only successfully parsed embedded specs enter this bounded cache. In
  // particular, do not share the page resolver's optional Orbital fallback.
  const cache = new LruSpecCache<SpecJson>();
  const pending = new Map<string, Promise<SpecJson>>();
  const readHash = deps.fetchHash ?? fetchWasmHash;
  const readSpec = deps.fetchSpec ?? fetchContractSpecByHash;
  const options = (): FetchOptions =>
    deps.options ?? {
      network: STELLAR_NETWORK,
      rpcUrl: SOROBAN_RPC_URL,
      allowHttp: ALLOW_HTTP,
      signal: AbortSignal.timeout(6_000),
    };

  async function load(hash: string, opts: FetchOptions): Promise<SpecJson> {
    const hit = await cache.get(hash);
    if (hit) return hit;
    let loading = pending.get(hash);
    if (!loading) {
      loading = readSpec(hash, opts)
        .then((parsed) => {
          const spec = toSpecJson(parsed);
          if (spec.provenance && spec.provenance !== 'embedded')
            throw new NoInterface('no_section');
          if (spec.wasmHash !== hash) {
            throw new RpcUnavailable(opts.rpcUrl, new Error('Reader returned another WASM hash'));
          }
          cache.set(hash, spec);
          return spec;
        })
        .finally(() => pending.delete(hash));
      pending.set(hash, loading);
    }
    return loading;
  }

  async function response(req: Request, hash: string, opts: FetchOptions, address?: string) {
    const spec = await load(hash, opts);
    const etag = `"${hash}"`;
    const headers = {
      ETag: etag,
      'Cache-Control': address ? ADDRESS_CACHE : HASH_CACHE,
      'Access-Control-Expose-Headers': 'ETag, Cache-Control',
    };
    if (matchesEtag(req.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return ok(
      {
        ...(address ? { address } : {}),
        network: opts.network,
        wasmHash: hash,
        spec,
        specSource: 'embedded' as const,
      },
      undefined,
      { headers },
    );
  }

  return {
    byAddress(req: Request, rawAddress: string): Promise<Response> {
      return withV1(async () => {
        const address = parseAddress(rawAddress, 'C');
        const opts = options();
        try {
          // Always refresh the address -> hash mapping. Only hash -> spec is
          // retained in memory, so an upgrade cannot stick to the old hash.
          const result = await readHash(address, opts);
          if (result.type !== 'wasm') throw new NoInterface('stellar_asset_contract');
          return await response(req, result.wasmHash, opts, address);
        } catch (error) {
          return specError(error);
        }
      })(req);
    },
    byHash(req: Request, rawHash: string): Promise<Response> {
      return withV1(async () => {
        if (!/^[0-9a-f]{64}$/i.test(rawHash)) {
          throw new V1Error('bad_request', 'Invalid WASM hash.', { parameter: 'wasmHash' });
        }
        try {
          return await response(req, rawHash.toLowerCase(), options());
        } catch (error) {
          return specError(error);
        }
      })(req);
    },
  };
}

export const contractSpecApi = createContractSpecApi();
