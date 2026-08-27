import { NextResponse } from 'next/server';
import { logger } from './logger.ts';
import { rateLimit } from './rate-limit.ts';
import { clientIp } from './security.ts';

/**
 * Rate limiting for the REST route handlers under `app/api`.
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
  /** Verifies a signature per call. */
  authVerify: 15,
  /** Cheap, but the entry point to the sign-in flow. */
  authChallenge: 20,
  /** Plain reads; generous, still bounded. */
  read: 60,
} as const;

const WINDOW_MS = 60_000;

/**
 * Enforce a rate limit for `req` in the named bucket.
 *
 * Returns a ready-to-send `429` when the caller is over budget, or `null` to
 * continue. Route handlers use it as an early return:
 *
 * ```ts
 * const limited = await enforceRateLimit(req, 'auth:challenge', LIMITS.authChallenge);
 * if (limited) return limited;
 * ```
 */
export async function enforceRateLimit(
  req: Request,
  bucket: string,
  max: number,
  windowMs: number = WINDOW_MS,
): Promise<NextResponse | null> {
  const ip = clientIp(req.headers);
  const { ok, resetMs } = await rateLimit(`http:${bucket}:${ip}`, max, windowMs);
  if (ok) return null;

  const retryAfter = Math.max(1, Math.ceil(resetMs / 1000));
  logger.warn({ bucket, ip, retryAfter }, 'http.rateLimited');

  return NextResponse.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'retry-after': String(retryAfter),
        'cache-control': 'no-store',
      },
    },
  );
}
