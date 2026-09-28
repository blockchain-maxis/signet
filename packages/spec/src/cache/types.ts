/**
 * @file @signet/spec/cache
 *
 * SpecCache interface for in-memory and external Soroban contract spec caching.
 *
 * Designed to be implemented by in-memory LRU stores (such as LruSpecCache),
 * database stores (Postgres), or Redis caches.
 *
 * §4.1: A hash's extracted spec is immutable, so entries are only ever evicted
 * for space, never invalidated for staleness.
 */

import type { ContractSpec } from '../types.ts';

/**
 * Common interface for caching decoded Soroban contract specifications keyed by WASM hash.
 */
export interface SpecCache<T = ContractSpec> {
  /**
   * Retrieve a cached contract specification by its hex-encoded WASM hash.
   * Updates recency in LRU stores. Returns undefined if not present.
   */
  get(wasmHash: string): Promise<T | undefined> | T | undefined;

  /**
   * Store a contract specification in the cache keyed by its hex-encoded WASM hash.
   * Evicts the least-recently used entry if capacity is exceeded in bounded stores.
   */
  set(wasmHash: string, spec: T): Promise<void> | void;

  /**
   * Optional check for presence without altering recency.
   */
  has?(wasmHash: string): Promise<boolean> | boolean;

  /**
   * Optional size query returning the current number of cached entries.
   */
  readonly size?: number;

  /**
   * Optional clear method to wipe all cached entries.
   */
  clear?(): Promise<void> | void;
}
