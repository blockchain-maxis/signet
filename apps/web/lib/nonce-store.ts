/**
 * Single-use nonce store, for replay protection on signed challenges.
 *
 * The Sign-In With Stellar challenge in `auth.ts` is a stateless HMAC over
 * `address|issued|nonce`. Stateless verification cannot tell a first
 * presentation from a tenth, so the same message and signature minted a fresh
 * session on every submission for the whole 5-minute TTL. Anyone who observed
 * one signed challenge — a logging sidecar, a malicious dapp that asked the
 * user to sign a "Signet sign-in" message — could take over the session inside
 * that window.
 *
 * `consume` records the nonce and reports whether *this* caller was the first
 * to present it. Second and later presentations get `false` and are rejected.
 *
 * Shaped like `RateLimitStore` in `rate-limit.ts` — same pluggable interface,
 * same lazy Upstash auto-detection — because a per-instance memory store is
 * not enough on a serverless deploy: a replay routed to a different instance
 * would find a clean slate.
 *
 * **This store fails closed**, which is the opposite of the rate limiter. A
 * limiter that fails open degrades to "unlimited", an annoyance; a nonce store
 * that fails open degrades to "replayable", a vulnerability. When the backend
 * cannot confirm a nonce is fresh, the sign-in is refused.
 */

export interface NonceStore {
  /**
   * Record `nonce` and return true if it had not been seen before, false if it
   * had — or if freshness could not be established at all.
   */
  consume(nonce: string, ttlMs: number): Promise<boolean>;
}

/**
 * Per-instance store. Correct on a single long-lived server; on a multi-replica
 * or serverless deploy, set the Upstash variables so replicas share one view.
 */
export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();

  async consume(nonce: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();

    // Entries are only meaningful until the challenge itself expires, so a
    // sweep of the expired ones bounds the map without a background timer.
    if (this.seen.size > 1_000) {
      for (const [key, expires] of this.seen) if (now > expires) this.seen.delete(key);
    }

    const expires = this.seen.get(nonce);
    if (expires !== undefined && now <= expires) return false;

    this.seen.set(nonce, now + ttlMs);
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}

/**
 * Shared store backed by Upstash Redis over its REST API (no TCP socket, so it
 * works in edge and serverless runtimes).
 *
 * `SET key value NX PX ttl` is atomic: it succeeds only if the key did not
 * exist, which is exactly "was I the first to present this nonce". Any error,
 * or an unrecognised reply, is treated as "cannot confirm" and rejects.
 */
export class UpstashNonceStore implements NonceStore {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  async consume(nonce: string, ttlMs: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/pipeline`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([['SET', `nonce:${nonce}`, '1', 'NX', 'PX', ttlMs]]),
      });
      if (!res.ok) return false;

      // `SET … NX` replies "OK" when it created the key, and null when the key
      // already existed — i.e. when this nonce has been presented before.
      const body = (await res.json()) as Array<{ result?: unknown; error?: string }>;
      return body[0]?.result === 'OK';
    } catch {
      return false;
    }
  }
}

let store: NonceStore = new MemoryNonceStore();
let storeResolved = false;
let initPromise: Promise<void> | null = null;

export function setNonceStore(s: NonceStore): void {
  store = s;
  storeResolved = true; // an explicit store wins over env-based auto-detection
}

/** Mirrors `rate-limit.ts`'s `ensureStore`: upgrade once, on first use. */
function ensureStore(): Promise<void> {
  if (storeResolved) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (store instanceof MemoryNonceStore && url && token) {
        setNonceStore(new UpstashNonceStore(url, token));
      }
      storeResolved = true;
    })();
  }
  return initPromise;
}

/** True only for the first presentation of `nonce`. */
export async function consumeNonce(nonce: string, ttlMs: number): Promise<boolean> {
  await ensureStore();
  return store.consume(nonce, ttlMs);
}

/** Test-only: reset to a fresh in-memory store and re-enable auto-detection. */
export function __resetNonceStore(): void {
  if (store instanceof MemoryNonceStore) store.clear();
  else store = new MemoryNonceStore();
  storeResolved = false;
  initPromise = null;
}
