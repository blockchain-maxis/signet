/**
 * @file @signet/spec/cache/lru
 *
 * In-memory size-bounded LRU cache keyed by WASM hash.
 *
 * Design (§4.1 of docs/CONTRACT_DOCS_DESIGN.md):
 * - Key on the WASM hash, not the address.
 * - A hash's extracted spec is immutable: identical code produces an identical interface.
 * - Nothing needs invalidating, and entries have NO TTL.
 *   Entries are only ever evicted for space (capacity limits), never for staleness or elapsed time.
 */

import type { ContractSpec } from '../types.ts';
import type { SpecCache } from './types.ts';

export const DEFAULT_LRU_CAPACITY = 500;

/**
 * Size-bounded in-memory LRU cache implementing SpecCache.
 *
 * Uses Map insertion/iteration order to maintain least-recently-used semantics
 * with O(1) reads, insertions, and evictions.
 */
export class LruSpecCache<T = ContractSpec> implements SpecCache<T> {
  private readonly capacity: number;
  private readonly entries: Map<string, T>;

  /**
   * @param capacity - Maximum number of specs to keep in memory (defaults to 500).
   */
  constructor(capacity: number = DEFAULT_LRU_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`LRU cache capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.entries = new Map<string, T>();
  }

  /**
   * Current number of entries stored in the cache.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Maximum capacity of the cache.
   */
  get maxCapacity(): number {
    return this.capacity;
  }

  /**
   * Retrieve a cached specification by WASM hash.
   * Promotes the entry to most-recently used if found.
   *
   * @param wasmHash - Lowercase 64-character SHA-256 hex hash
   * @returns The cached spec, or undefined if not present
   */
  get(wasmHash: string): T | undefined {
    const key = wasmHash.toLowerCase();
    if (!this.entries.has(key)) {
      return undefined;
    }
    const val = this.entries.get(key)!;
    // Re-insert to refresh recency (moves key to end of Map iteration order)
    this.entries.delete(key);
    this.entries.set(key, val);
    return val;
  }

  /**
   * Store a specification in the cache.
   * If capacity is exceeded, evicts the least-recently used entry.
   *
   * Note (§4.1): There is intentionally NO TTL expiration. A WASM hash's
   * extracted specification is immutable. Eviction happens solely for space.
   *
   * @param wasmHash - Lowercase 64-character SHA-256 hex hash
   * @param spec - Decoded contract specification
   */
  set(wasmHash: string, spec: T): void {
    const key = wasmHash.toLowerCase();
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.capacity) {
      // Map.keys().next().value gives the oldest (least-recently used) entry
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, spec);
  }

  /**
   * Check if a WASM hash exists in cache without updating its recency.
   */
  has(wasmHash: string): boolean {
    return this.entries.has(wasmHash.toLowerCase());
  }

  /**
   * Delete a specific entry by WASM hash.
   */
  delete(wasmHash: string): boolean {
    return this.entries.delete(wasmHash.toLowerCase());
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.entries.clear();
  }
}
