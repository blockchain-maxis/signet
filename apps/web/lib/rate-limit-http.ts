import { NextResponse } from 'next/server';
import { LIMITS, WINDOW_MS, rateLimitDecision } from './rate-limit-policy.ts';

/**
 * `NextResponse` adapter over `rate-limit-policy.ts`.
 *
 * The budgets and the over-budget decision live in that module so they can be
 * unit tested — importing `next/server` makes a module unloadable by the node
 * test runner. All this adds is the response.
 */

export { LIMITS } from './rate-limit-policy.ts';

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
  const refusal = await rateLimitDecision(req.headers, bucket, max, windowMs);
  if (!refusal) return null;

  return NextResponse.json(
    { error: 'Too many requests' },
    {
      status: 429,
      headers: {
        'retry-after': String(refusal.retryAfter),
        'cache-control': 'no-store',
      },
    },
  );
}
