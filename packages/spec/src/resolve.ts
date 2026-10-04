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

import { InterfaceUnreadable, NoInterface } from './errors.ts';
import { fetchContractSpec, fetchWasmHash } from './fetch.ts';
import type { FetchOptions } from './fetch.ts';
import { toSpecJson } from './json.ts';
import type { SpecJson } from './json.ts';
import type { SpecCache } from './cache/types.ts';

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
}

/** Result of {@link getContractSpec}. */
export interface ResolvedContractSpec {
  readonly spec: SpecJson;
  readonly source: SpecSource;
  /** Lowercase hex WASM hash the spec was resolved for. */
  readonly wasmHash: string;
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
    return { spec: hit, source: index === 0 ? 'memory' : 'store', wasmHash };
  }

  let pending = inFlight.get(wasmHash);
  if (pending === undefined) {
    pending = fetchAndStore(address, wasmHash, opts).finally(() => {
      inFlight.delete(wasmHash);
    });
    inFlight.set(wasmHash, pending);
  }
  return { spec: await pending, source: 'rpc', wasmHash };
}

async function currentWasmHash(address: string, opts: GetContractSpecOptions): Promise<string> {
  if (opts.knownWasmHash !== undefined) return opts.knownWasmHash.toLowerCase();
  const result = await fetchWasmHash(address, opts);
  if (result.type === 'stellar_asset') throw new NoInterface('stellar_asset_contract');
  return result.wasmHash;
}

async function fetchAndStore(
  address: string,
  wasmHash: string,
  opts: GetContractSpecOptions,
): Promise<SpecJson> {
  let json: SpecJson;
  try {
    json = toSpecJson(await fetchContractSpec(address, opts));
  } catch (error) {
    if (error instanceof InterfaceUnreadable) {
      opts.logger?.warn('contract interface could not be read', {
        wasmHash,
        sdkVersion: error.sdkVersion,
      });
    }
    throw error;
  }
  await Promise.all(opts.caches.map((cache) => writeCache(cache, wasmHash, json, opts)));
  return json;
}

async function readCache(
  cache: SpecCache<SpecJson>,
  wasmHash: string,
  opts: GetContractSpecOptions,
): Promise<SpecJson | undefined> {
  try {
    return await cache.get(wasmHash);
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
