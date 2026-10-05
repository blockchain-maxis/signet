/**
 * @file apps/web/lib/server/contract-spec.ts
 *
 * The one server-side call that turns the `Contract` row the shell already
 * loaded into a spec or a §1.5 failure (#464, docs/CONTRACT_DOCS_DESIGN.md).
 * The Overview tab, the docs view and the visualiser all read through it, so
 * they share one memory LRU and one Postgres store and never disagree about
 * what a contract's interface is.
 *
 * It never throws: every error becomes a `SpecFailure`, a plain object of
 * strings that survives the server/client boundary.
 */
import { LruSpecCache, type SpecCache, type SpecJson } from '@signet/spec';
import type { GetContractSpecOptions, ResolvedContractSpec } from '@signet/spec/resolve';
import { normalizeNetwork, type Network } from '@signet/types';
import { ALLOW_HTTP, SOROBAN_RPC_URL, STELLAR_NETWORK } from '../chain.ts';
import { classifySpecError, withFlattenedViews, type SpecFailure } from '../contract-overview.ts';
import { logger } from '../logger.ts';
import { PrismaSpecCache, SPEC_SCHEMA_VERSION, isStale } from './spec-store.ts';

/** Deadline for the whole interface resolution, so a slow RPC cannot stall the page. */
const RESOLVE_TIMEOUT_MS = 6_000;

/** Module-level so every request on this server instance shares it. */
const memory = new LruSpecCache<SpecJson>();

/**
 * Adapter from the Postgres store to the resolver's `SpecCache<SpecJson>`. A
 * stale row (older SDK or schema, §4.2) reads as a miss so it is re-extracted
 * and overwritten rather than served.
 */
function postgresCache(store = new PrismaSpecCache()): SpecCache<SpecJson> {
  return {
    async get(wasmHash) {
      const row = await store.get(wasmHash);
      if (!row || isStale(row)) return undefined;
      return row.specJson as SpecJson;
    },
    async set(wasmHash, spec) {
      await store.set(wasmHash, {
        schemaVersion: SPEC_SCHEMA_VERSION,
        sdkVersion: spec.sdkVersion,
        specJson: spec,
      });
    },
  };
}

/**
 * The cache chain, fastest first: the shared memory LRU, then the Postgres
 * store when `DATABASE_URL` is set. Without a database it is the memory cache
 * alone, so previews and local dev work unconfigured.
 */
export function specCaches(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
  store?: PrismaSpecCache,
): readonly SpecCache<SpecJson>[] {
  return databaseUrl ? [memory, postgresCache(store)] : [memory];
}

/** Canonical network name; an unrecognised one is kept as written so it can be reported. */
function canonicalNetwork(raw: string): string {
  try {
    return normalizeNetwork(raw);
  } catch {
    return raw;
  }
}

export interface ContractSpecRequest {
  address: string;
  /** The contract's network, as stored on its `Contract` row. */
  network: string;
  /** Indexed WASM hash; `null` on the Horizon attribution path (read from the chain instead). */
  wasmHash: string | null;
}

/** A resolved spec: `source` says which tier served it. */
export type ContractSpecResult =
  | {
      readonly ok: true;
      readonly spec: SpecJson;
      readonly source: ResolvedContractSpec['source'];
      readonly wasmHash: string;
    }
  | { readonly ok: false; readonly failure: SpecFailure };

/** Seams for tests; production passes none. */
export interface ContractSpecDeps {
  resolve?: (address: string, opts: GetContractSpecOptions) => Promise<ResolvedContractSpec>;
  caches?: readonly SpecCache<SpecJson>[];
  /** Network this deployment reads. Defaults to `STELLAR_NETWORK`. */
  appNetwork?: string;
  rpcUrl?: string;
  allowHttp?: boolean;
  timeoutMs?: number;
}

/**
 * Load a contract's interface, or say why there is none.
 *
 * The contract's network must be the app's: the RPC URL is the app's, so
 * querying it for another network's address would answer about the wrong
 * chain. A mismatch returns `wrong_network` before any RPC call or cache
 * read.
 *
 * Caching: a spec is immutable per WASM hash (§4.1) and the cache is keyed by
 * it, so an upgraded contract resolves under its new hash with no
 * invalidation. The route should therefore be static-first: set
 * `export const revalidate = 3600` (an hour) on the shell. That bounds how
 * long a changed `Contract.wasmHash` takes to show, while the spec itself is
 * never refetched for a hash already stored. Failures are not cached.
 *
 * @param request - address, network and indexed hash from the `Contract` row.
 * @param deps - test seams; defaults are the real resolver and caches.
 * @returns the spec with its source, or a serialisable failure. Never throws.
 */
export async function loadContractSpec(
  request: ContractSpecRequest,
  deps: ContractSpecDeps = {},
): Promise<ContractSpecResult> {
  try {
    const expected = deps.appNetwork ?? STELLAR_NETWORK;
    const network = canonicalNetwork(request.network);
    if (network !== expected) {
      return { ok: false, failure: { kind: 'wrong_network', network, expectedNetwork: expected } };
    }

    const resolve = deps.resolve ?? (await import('@signet/spec/resolve')).getContractSpec;
    const resolved = await resolve(request.address, {
      network: expected as Network,
      rpcUrl: deps.rpcUrl ?? SOROBAN_RPC_URL,
      allowHttp: deps.allowHttp ?? ALLOW_HTTP,
      signal: AbortSignal.timeout(deps.timeoutMs ?? RESOLVE_TIMEOUT_MS),
      caches: deps.caches ?? specCaches(),
      ...(request.wasmHash ? { knownWasmHash: request.wasmHash } : {}),
      logger: {
        warn: (message, context) => logger.warn({ ...context }, message),
      },
    });
    return {
      ok: true,
      spec: withFlattenedViews(resolved.spec),
      source: resolved.source,
      wasmHash: resolved.wasmHash,
    };
  } catch (error) {
    return { ok: false, failure: classifySpecError(error, request.network) };
  }
}
