/**
 * @file apps/web/lib/server/contract-cache.ts
 *
 * Caching for the contract route (#458). Every cache the route uses is listed
 * here, with its key, its lifetime and why.
 *
 * **The HTML itself is never cached.** The route is `force-dynamic`: the root
 * layout reads the CSP nonce through `headers()`, so full-page caching is
 * unavailable and every request renders. The page is fast through data
 * caching instead, and without it one render could run the attribution query,
 * a live instance read, a spec fetch and a snapshot query, several of them more
 * than once across the layout, `generateMetadata` and the page.
 *
 * Per request (React `cache()`, one run per render, gone when it ends):
 *
 * | What                          | Where                                      |
 * | ----------------------------- | ------------------------------------------ |
 * | Attribution verdict           | `attributeContract` (`contract-attribution`) |
 * | Live instance read            | `loadLiveInstance` (`contract-header-source`) |
 * | Newest activity snapshot      | `getContractActivity` (`contract-activity`) |
 *
 * Across requests. A lifetime below is how long an entry is *fresh*. Next's data
 * cache is stale-while-revalidate: the first read after expiry still gets the old
 * value and starts a refresh, and the read after that is current. So a value is
 * wrong for at most its lifetime plus one render. (The in-memory `DataCache`
 * below does not model that extra read; it expires exactly.)
 *
 * | What                       | Key                              | Lifetime  | Why |
 * | -------------------------- | -------------------------------- | --------- | --- |
 * | Interface (spec)           | `wasmHash`                       | forever   | A WASM hash names its bytes, so the spec cannot change (CONTRACT_DOCS_DESIGN.md 4.1). This is the #435/#436 cache read through `getContractSpec` (#437), not a second one: memory LRU, then Postgres. |
 * | Attribution, a match       | `contract:{address}` + handle    | 300 s     | Ownership of a deployed contract does not move. Next's data cache, tagged `contract:{address}` so it can be revalidated by tag. |
 * | Attribution, a miss        | address + handle + network       | 30 s      | Short on purpose: a deployment the indexer has just recorded must appear quickly. In-process, because the data cache has one lifetime per entry and a hit and a miss need two. |
 * | Live instance WASM hash    | address + network                | 60 s      | An upgrade changes the hash without changing the address, so this is the one value that can go stale; a minute (plus one render) bounds it. Next's data cache. |
 * | Horizon fallback fetches   | the Horizon URL                  | 300 s     | `next: { revalidate: 300 }` on the fetches themselves (`lib/server/horizon.ts`, `getResultMetaXdr`). |
 *
 * Never cached, in any layer: "the database is unavailable" (an outage must not
 * look like a verdict), and a failed live read. A cache that remembered those
 * would keep serving a stale failure after the cause was gone.
 *
 * `unstable_cache` is what the issue specifies and is still supported, but the
 * Next 16 docs say `use cache` replaces it. `use cache` needs Cache Components,
 * which does not combine with this route's `force-dynamic`; moving to it is a
 * separate change. Everything below talks to a `DataCache`, so it is also the
 * one place to swap.
 */

/** Lifetimes, in seconds. */
export const ATTRIBUTION_HIT_TTL_SECONDS = 300;
export const ATTRIBUTION_MISS_TTL_SECONDS = 30;
export const LIVE_INSTANCE_TTL_SECONDS = 60;

/** The tag every cached entry about one contract carries. */
export function contractTag(address: string): string {
  return `contract:${address}`;
}

/** What a cached computation returns: the value, and whether it may be remembered. */
export type Cacheable<T> = { readonly value: T; readonly cache: boolean };

/**
 * The cross-request cache. `compute` runs on a miss; its result is remembered
 * for `ttlSeconds` only when it says `cache: true`. `value` must survive JSON:
 * a `Date` comes back from the cache as a string.
 */
export interface DataCache {
  remember<T>(spec: {
    key: readonly string[];
    tags: readonly string[];
    ttlSeconds: number;
    compute: () => Promise<Cacheable<T>>;
  }): Promise<T>;
}

/** Thrown inside `unstable_cache` to refuse to remember a result: errors are not cached. */
class NotRemembered<T> extends Error {
  readonly value: T;

  constructor(value: T) {
    super('not remembered');
    this.value = value;
  }
}

/**
 * Next's data cache. `unstable_cache` has no way to skip writing a result, but
 * it does not write when the function throws, so a result that must not be
 * remembered is thrown inside it and caught outside. `next/cache` is imported on
 * first use so that importing this module (unit tests) does not load Next.
 */
export const nextDataCache: DataCache = {
  async remember<T>(spec: Parameters<DataCache['remember']>[0]): Promise<T> {
    const { unstable_cache } = await import('next/cache');
    const cached = unstable_cache(
      async () => {
        const result = await spec.compute();
        if (!result.cache) throw new NotRemembered(result.value);
        return result.value as T;
      },
      [...spec.key],
      { revalidate: spec.ttlSeconds, tags: [...spec.tags] },
    );
    try {
      return await cached();
    } catch (error) {
      if (error instanceof NotRemembered) return error.value as T;
      throw error;
    }
  },
};

/**
 * In-memory `DataCache` with an injectable clock: what the unit tests use to
 * see lifetimes, and what a developer can use where Next's cache is not available.
 */
export function createMemoryDataCache(now: () => number = Date.now): DataCache & {
  /** Drop every entry, or only those carrying `tag`. */
  clear(tag?: string): void;
} {
  const entries = new Map<string, { value: unknown; expiresAt: number; tags: readonly string[] }>();
  return {
    async remember<T>(spec: Parameters<DataCache['remember']>[0]): Promise<T> {
      const id = JSON.stringify(spec.key);
      const hit = entries.get(id);
      if (hit && hit.expiresAt > now()) return hit.value as T;
      const result = await spec.compute();
      if (result.cache) {
        entries.set(id, {
          value: result.value,
          expiresAt: now() + spec.ttlSeconds * 1000,
          tags: spec.tags,
        });
      }
      return result.value as T;
    },
    clear(tag) {
      for (const [id, entry] of entries) {
        if (tag === undefined || entry.tags.includes(tag)) entries.delete(id);
      }
    },
  };
}

/** Most misses remembered at once; address space is open to anyone, so the map is bounded. */
const MAX_MISSES = 1_000;

/**
 * A short-lived memory of "no such row". In-process: each instance learns a miss
 * on its own and forgets it within `ttlSeconds`, which is the point.
 */
export class MissMemo {
  private readonly until = new Map<string, number>();
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(ttlSeconds: number = ATTRIBUTION_MISS_TTL_SECONDS, now: () => number = Date.now) {
    this.ttlSeconds = ttlSeconds;
    this.now = now;
  }

  has(key: string): boolean {
    const until = this.until.get(key);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  remember(key: string): void {
    const now = this.now();
    if (this.until.size >= MAX_MISSES) {
      for (const [k, t] of this.until) if (t <= now) this.until.delete(k);
      // Still full of live entries: drop the oldest, which is the first inserted.
      if (this.until.size >= MAX_MISSES) {
        const oldest = this.until.keys().next();
        if (!oldest.done) this.until.delete(oldest.value);
      }
    }
    this.until.delete(key); // re-insert so insertion order tracks recency
    this.until.set(key, now + this.ttlSeconds * 1000);
  }

  clear(): void {
    this.until.clear();
  }
}
