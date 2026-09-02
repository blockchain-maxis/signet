import { logger } from './logger.ts';
import { rateLimit } from './rate-limit.ts';
import { clientIp } from './security.ts';

/**
 * The rate-limiting policy for the REST route handlers under `app/api` — the
 * budgets themselves, and the decision of whether a given request is over one.
 *
 * Kept separate from `rate-limit-http.ts` so it can be unit tested: that module
 * imports `next/server` for `NextResponse`, and the `next` package ships no
 * `exports` map, so Node's ESM resolver cannot load the `next/server` subpath
 * under `node --test`. Everything here is plain TypeScript over `Headers`, so
 * the table and the enforcement are both reachable from a test. Same split, and
 * the same reason, as `lib/sitemap.ts`.
 *
 * The tRPC procedures have gone through `rateLimit()` from the start, but the
 * hand-written route handlers never did — so the endpoints that cost the most
 * to serve were the only ones anyone could call without limit:
 *
 *   • `GET /api/auth/sep10` builds and *signs* a challenge transaction. It is
 *     unauthenticated and serves `Access-Control-Allow-Origin: *`, so any web
 *     page in the world could drive ed25519 signing on this server.
 *   • `POST /api/auth/verify` runs an ed25519 verification per call.
 *   • `POST /api/auth/challenge` mints HMAC-tagged challenges.
 *
 * Buckets are namespaced per endpoint so a flood against one cannot exhaust
 * another's budget, and so the auth endpoints can be held to a much tighter
 * limit than ordinary reads.
 */

/** Per-minute allowances, chosen against what each endpoint costs to serve. */
export const LIMITS = {
  /** Signs a transaction per call — the most expensive unauthenticated path. */
  sep10: 12,
  /**
   * Mints a pairing code for an unauthenticated CLI. Same shape as `sep10` —
   * anyone on the internet can drive it — so it gets the same tight budget.
   */
  cliPairStart: 12,
  /** Verifies an ed25519 signature per call, like `sep10`. */
  cliPairComplete: 12,
  /** Verifies a signature per call. */
  authVerify: 15,
  /** Cheap, but the entry point to the sign-in flow. */
  authChallenge: 20,
  /** Sign-out-everywhere: authenticated and rare, so a tight bucket is plenty. */
  authRevoke: 10,
  /** Plain reads; generous, still bounded. */
  read: 60,
  /**
   * Browser-posted CSP violation reports. A genuinely broken directive can fire
   * once per blocked subresource, so the ceiling is high enough that a real
   * page's first load reports in full, and still bounded — the endpoint is
   * unauthenticated and its payload is attacker-influenceable.
   */
  cspReport: 120,
} as const;

export const WINDOW_MS = 60_000;

/** What a caller must be told when it is over budget. */
export interface RateLimitRefusal {
  /** Seconds until the bucket refills; at least 1, for the `retry-after` header. */
  retryAfter: number;
}

/**
 * Decide whether `headers` are over budget in `bucket`, and log the refusal.
 *
 * Returns `null` to continue, or the refusal to render. `enforceRateLimit` in
 * `rate-limit-http.ts` is the thin wrapper that turns this into a `429`.
 */
export async function rateLimitDecision(
  headers: Headers,
  bucket: string,
  max: number,
  windowMs: number = WINDOW_MS,
): Promise<RateLimitRefusal | null> {
  const ip = clientIp(headers);
  const { ok, resetMs } = await rateLimit(`http:${bucket}:${ip}`, max, windowMs);
  if (ok) return null;

  const retryAfter = Math.max(1, Math.ceil(resetMs / 1000));
  logger.warn({ bucket, ip, retryAfter }, 'http.rateLimited');
  return { retryAfter };
}
