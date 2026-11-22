/**
 * @file @signet/spec
 *
 * Cached resolver over the fetch half of the spec reader (§4 of
 * docs/CONTRACT_DOCS_DESIGN.md): one call that finds a contract's current WASM
 * hash, serves its spec from memory or a store, and fetches and decodes only
 * on a true miss.
 *
 * Node-only, like `fetch.ts`: published through the `@signet/spec/resolve`
 * export path so the browser-safe `@signet/spec` surface stays network-free.
 */

import { InterfaceUnreadable, NoInterface, RpcUnavailable } from './errors.ts';
import { fetchContractSpec, fetchContractSpecByHash, fetchWasmHash } from './fetch.ts';
import type { FetchOptions } from './fetch.ts';
import { toSpecJson } from './json.ts';
import type { SpecJson } from './json.ts';
import type { SpecProvenance } from './types.ts';
import type { SpecCache } from './cache/types.ts';
import type { SpecFallback } from './fallback/types.ts';
import { orbitalFallback } from './fallback/orbital.ts';

/** Minimal structured logger the resolver reports through; `console` fits. */
export interface ResolveLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** Where a resolved spec came from. */
export type SpecSource = 'memory' | 'store' | 'rpc';

/**
 * Options for {@link getContractSpec}: the fetch options (network, RPC
 * endpoint, injected server, signal) plus the cache chain.
 */
export interface GetContractSpecOptions extends FetchOptions {
  /**
   * Caches in lookup order, fastest first. A hit in the first cache reports
   * `source: 'memory'`; a hit in any later one reports `'store'`. A hit also
   * back-fills every cache ahead of it.
   */
  readonly caches: readonly SpecCache<SpecJson>[];
  /**
   * WASM hash already known for this address (`Contract.wasmHash`). When given
   * it is trusted and the instance entry is not read, so a cache hit costs
   * zero RPC calls. Omit it to read the current hash from the chain.
   */
  readonly knownWasmHash?: string;
  /** Receives the `InterfaceUnreadable` warning (§1.5). */
  readonly logger?: ResolveLogger;
  /**
   * Optional fallback when a contract embeds no spec section (`NoInterface{no_section}`).
   * When omitted and `SIGNET_SPEC_ORBITAL_FALLBACK=1`, uses `orbitalFallback`.
   */
  readonly fallback?: SpecFallback;
}

/** Result of {@link getContractSpec}. */
export interface ResolvedContractSpec {
  readonly spec: SpecJson;
  readonly source: SpecSource;
  /** Lowercase hex WASM hash the spec was resolved for. */
  readonly wasmHash: string;
  readonly provenance?: SpecProvenance;
  readonly attestationPointer?: string;
  readonly attestationHash?: string;
}

/**
 * Fetches in flight, keyed by WASM hash. A spec is immutable per hash (§4.1),
 * so every concurrent miss for the same hash can share one download no matter
 * which address or caller asked.
 */
const inFlight = new Map<string, Promise<SpecJson>>();

/**
 * Resolve a contract's interface spec through the cache chain.
 *
 * 1. The hash is `opts.knownWasmHash` or, without it, `fetchWasmHash`.
 * 2. Caches are walked in order; a hit back-fills the caches ahead of it.
 * 3. A miss runs `fetchContractSpec` once per hash (concurrent misses share
 *    the promise), converts to `SpecJson` and writes it to every cache.
 *
 * An upgraded contract resolves under its new hash; the old hash's cache
 * entries are left alone since they still describe that code. Cache read or
 * write failures are logged and treated as misses: a cache is an
 * optimisation, never a reason to fail a page.
 *
 * @param address - contract address in `C...` strkey form.
 * @param opts - fetch options, cache chain, optional known hash and logger.
 * @throws `NoInterface{stellar_asset_contract}` for a SAC, `InterfaceUnreadable`
 *   (logged at `warn` with `{ wasmHash, sdkVersion }`, never cached), and the
 *   other `fetchContractSpec` errors. Failures are not cached either.
 */
export async function getContractSpec(
  address: string,
  opts: GetContractSpecOptions,
): Promise<ResolvedContractSpec> {
  const wasmHash = await currentWasmHash(address, opts);

  for (const [index, cache] of opts.caches.entries()) {
    const hit = await readCache(cache, wasmHash, opts);
    if (hit === undefined) continue;
    await Promise.all(opts.caches.slice(0, index).map((c) => writeCache(c, wasmHash, hit, opts)));
    return {
      spec: hit,
      source: index === 0 ? 'memory' : 'store',
      wasmHash,
      provenance: hit.provenance ?? 'embedded',
      ...(hit.attestationPointer ? { attestationPointer: hit.attestationPointer } : {}),
      ...(hit.attestationHash ? { attestationHash: hit.attestationHash } : {}),
    };
  }

  let pending = inFlight.get(wasmHash);
  if (pending === undefined) {
    pending = fetchAndStore(address, wasmHash, opts).finally(() => {
      inFlight.delete(wasmHash);
    });
    inFlight.set(wasmHash, pending);
  }
  const spec = await pending;
  return {
    spec,
    source: 'rpc',
    wasmHash,
    provenance: spec.provenance ?? 'embedded',
    ...(spec.attestationPointer ? { attestationPointer: spec.attestationPointer } : {}),
    ...(spec.attestationHash ? { attestationHash: spec.attestationHash } : {}),
  };
}

async function currentWasmHash(address: string, opts: GetContractSpecOptions): Promise<string> {
  if (opts.knownWasmHash !== undefined) return opts.knownWasmHash.toLowerCase();
  const result = await fetchWasmHash(address, opts);
  if (result.type === 'stellar_asset') throw new NoInterface('stellar_asset_contract');
  return result.wasmHash;
}

function assertHashMatches(spec: SpecJson, expectedHash: string, rpcUrl: string): void {
  if (spec.wasmHash.toLowerCase() !== expectedHash) {
    throw new RpcUnavailable(
      rpcUrl,
      new Error(`Fetched WASM hash ${spec.wasmHash} does not match expected hash ${expectedHash}`),
    );
  }
}

async function fetchAndStore(
  address: string,
  wasmHash: string,
  opts: GetContractSpecOptions,
): Promise<SpecJson> {
  let json: SpecJson;
  try {
    const spec =
      opts.knownWasmHash !== undefined
        ? await fetchContractSpecByHash(wasmHash, opts)
        : await fetchContractSpec(address, opts);
    json = toSpecJson(spec);
    json.provenance = 'embedded';
  } catch (error) {
    if (error instanceof NoInterface && error.reason === 'no_section') {
      const fallback =
        opts.fallback ??
        (typeof process !== 'undefined' && process.env?.SIGNET_SPEC_ORBITAL_FALLBACK === '1'
          ? orbitalFallback
          : undefined);

      if (fallback) {
        const fallbackResult = await fallback.resolve(address, wasmHash, {
          signal: opts.signal,
          logger: opts.logger,
        });

        if (fallbackResult) {
          json = {
            ...fallbackResult.spec,
            provenance: 'orbital_registry',
            attestationPointer: fallbackResult.attestationPointer,
            attestationHash: fallbackResult.attestationHash,
          };
          assertHashMatches(json, wasmHash, opts.rpcUrl);
          await Promise.all(opts.caches.map((cache) => writeCache(cache, wasmHash, json, opts)));
          return json;
        }
      }
    }

    if (error instanceof InterfaceUnreadable) {
      opts.logger?.warn('contract interface could not be read', {
        wasmHash,
        sdkVersion: error.sdkVersion,
      });
    }
    throw error;
  }
  assertHashMatches(json, wasmHash, opts.rpcUrl);
  await Promise.all(opts.caches.map((cache) => writeCache(cache, wasmHash, json, opts)));
  return json;
}

async function readCache(
  cache: SpecCache<SpecJson>,
  wasmHash: string,
  opts: GetContractSpecOptions,
): Promise<SpecJson | undefined> {
  try {
    const hit = await cache.get(wasmHash);
    if (hit === undefined) return undefined;
    if (hit.wasmHash.toLowerCase() !== wasmHash) {
      opts.logger?.warn('spec cache entry hash mismatch', {
        wasmHash,
        cachedWasmHash: hit.wasmHash,
      });
      return undefined;
    }
    return hit;
  } catch (error) {
    opts.logger?.warn('spec cache read failed', { wasmHash, error });
    return undefined;
  }
}

async function writeCache(
  cache: SpecCache<SpecJson>,
  wasmHash: string,
  spec: SpecJson,
  opts: GetContractSpecOptions,
): Promise<void> {
  try {
    await cache.set(wasmHash, spec);
  } catch (error) {
    opts.logger?.warn('spec cache write failed', { wasmHash, error });
  }
}
