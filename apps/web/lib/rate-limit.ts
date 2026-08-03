/**
 * Pluggable rate limiter.
 *
 * Ships with an in-memory fixed-window store (per-instance, best-effort). For a
 * horizontally-scaled / serverless deployment, implement `RateLimitStore`
 * against a shared backend (e.g. Upstash Redis) and register it once at startup
 * with `setRateLimitStore(...)` — the call sites (`await rateLimit(key)`) don't
 * change. The async signature is what makes that swap drop-in.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 60;
const MAX_KEYS = 10_000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetMs: number;
}

export interface RateLimitStore {
  hit(key: string, max: number, windowMs: number): Promise<RateLimitResult>;
}

type Entry = { count: number; reset: number };

class MemoryStore implements RateLimitStore {
  private hits = new Map<string, Entry>();

  async hit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    if (this.hits.size > MAX_KEYS) {
      for (const [k, v] of this.hits) if (now > v.reset) this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (!entry || now > entry.reset) {
      this.hits.set(key, { count: 1, reset: now + windowMs });
      return { ok: true, remaining: max - 1, resetMs: windowMs };
    }
    entry.count += 1;
    return { ok: entry.count <= max, remaining: Math.max(0, max - entry.count), resetMs: entry.reset - now };
  }

  clear(): void {
    this.hits.clear();
  }
}

let store: RateLimitStore = new MemoryStore();
let storeResolved = false;
let initPromise: Promise<void> | null = null;

export function setRateLimitStore(s: RateLimitStore): void {
  store = s;
  storeResolved = true; // an explicit store wins over env-based auto-detection
}

/**
 * Lazily upgrade the default in-memory store to the shared Upstash store when
 * its env is present. Runs at most once (on the first `rateLimit` call) so the
 * Redis module is never imported in environments that don't use it.
 */
function ensureStore(): Promise<void> {
  if (storeResolved) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (store instanceof MemoryStore && url && token) {
        const { UpstashRateLimitStore } = await import('./rate-limit-redis.ts');
        setRateLimitStore(new UpstashRateLimitStore(url, token));
      }
      storeResolved = true;
    })();
  }
  return initPromise;
}

export async function rateLimit(
  key: string,
  max = MAX_PER_WINDOW,
  windowMs = WINDOW_MS,
): Promise<RateLimitResult> {
  await ensureStore();
  return store.hit(key, max, windowMs);
}

/** Test-only: reset to a fresh in-memory store and re-enable auto-detection. */
export function __resetRateLimit(): void {
  if (store instanceof MemoryStore) store.clear();
  else store = new MemoryStore();
  storeResolved = false;
  initPromise = null;
}
