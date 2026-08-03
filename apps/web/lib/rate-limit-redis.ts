import type { RateLimitResult, RateLimitStore } from './rate-limit.ts';

/**
 * Shared-backend rate-limit store for horizontally-scaled / serverless deploys.
 *
 * The in-memory store in `rate-limit.ts` is per-instance, so on Vercel/Netlify
 * functions (or any multi-replica deploy) each instance counts independently and
 * the effective limit multiplies by the replica count. This store keeps the
 * count in Upstash Redis (HTTP/REST — no TCP socket, works in edge/serverless)
 * so the window is enforced globally.
 *
 * It is registered automatically by `rate-limit.ts` whenever
 * `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set; no call-site
 * changes are needed. Fails open (allows the request) on any backend error so a
 * Redis blip degrades to "unlimited" rather than taking the API down.
 */
export class UpstashRateLimitStore implements RateLimitStore {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  async hit(key: string, max: number, windowMs: number): Promise<RateLimitResult> {
    // Fixed-window via a Redis pipeline:
    //   INCR  → current count in the window
    //   PEXPIRE … NX → set the window TTL only on the first hit
    //   PTTL  → ms remaining until the window resets
    const namespaced = `ratelimit:${key}`;
    try {
      const res = await fetch(`${this.url}/pipeline`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify([
          ['INCR', namespaced],
          ['PEXPIRE', namespaced, windowMs, 'NX'],
          ['PTTL', namespaced],
        ]),
      });
      if (!res.ok) return this.allow(max, windowMs);

      const body = (await res.json()) as Array<{ result?: number; error?: string }>;
      const count = Number(body[0]?.result ?? 0);
      const pttl = Number(body[2]?.result ?? windowMs);
      const resetMs = pttl > 0 ? pttl : windowMs;

      return {
        ok: count <= max,
        remaining: Math.max(0, max - count),
        resetMs,
      };
    } catch {
      return this.allow(max, windowMs);
    }
  }

  /** Fail-open result — never block legitimate traffic on a backend hiccup. */
  private allow(max: number, windowMs: number): RateLimitResult {
    return { ok: true, remaining: max - 1, resetMs: windowMs };
  }
}
