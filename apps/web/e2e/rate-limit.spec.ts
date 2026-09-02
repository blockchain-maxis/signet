import { test, expect, type APIRequestContext } from '@playwright/test';

/**
 * End-to-end coverage for the API rate limiter (issue #212).
 *
 * The limiter's correctness depends on client-IP attribution in
 * `lib/security.ts`, which is deliberately conservative: without a platform
 * header it puts every caller in one shared `unknown` bucket rather than
 * handing each a free one. That is only safe if the shared bucket is actually
 * enforced, which is what the last test here proves.
 *
 * Three things make this spec fussier than it looks:
 *
 *  1. `/api/p/<handle>/operations` can reach Horizon, so 60 *sequential*
 *     requests overrun the 30s default test timeout. They are issued in
 *     concurrent batches instead, and the timeout is raised for headroom.
 *  2. A bucket is keyed by IP and only refills after `WINDOW_MS` (60s), so a
 *     test that burns a fixed IP cannot repeat inside the window — and CI runs
 *     with `retries: 2`. Every bucket-burning test derives its IP from the
 *     attempt number so a retry starts clean.
 *  3. The `unknown` bucket is shared with anything else that reaches the same
 *     route without a platform header, and `fullyParallel` is on. That test
 *     therefore asserts the bucket is *bounded and shared*, never that it
 *     starts empty.
 */

const BUCKET_LIMIT = 60; // LIMITS.read in lib/rate-limit-http.ts, and rate-limit.ts's MAX_PER_WINDOW
const BATCH = 15;

/** Unique per test and per retry, so a burnt bucket is never reused. */
function ip(testId: number, retry: number): string {
  return `10.99.${retry}.${testId}`;
}

/** Issue `count` GETs in concurrent batches and return every status. */
async function flood(
  request: APIRequestContext,
  path: string,
  count: number,
  headers?: Record<string, string>,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let sent = 0; sent < count; sent += BATCH) {
    const size = Math.min(BATCH, count - sent);
    const batch = await Promise.all(
      Array.from({ length: size }, () => request.get(path, headers ? { headers } : {})),
    );
    statuses.push(...batch.map((r) => r.status()));
  }
  return statuses;
}

test.describe('API rate limiting', () => {
  // 60+ HTTP round trips per test, some of which reach Horizon.
  test.setTimeout(90_000);

  test('the operations route enforces its bucket, per IP', async ({ request }, testInfo) => {
    const mine = { 'x-vercel-forwarded-for': ip(1, testInfo.retry) };

    const statuses = await flood(request, '/api/p/aquawolf/operations', BUCKET_LIMIT, mine);
    expect(statuses.every((s) => s === 200)).toBeTruthy();

    // Budget spent: the next call is refused.
    const limited = await request.get('/api/p/aquawolf/operations', { headers: mine });
    expect(limited.status()).toBe(429);
    expect(limited.headers()['retry-after']).toBeTruthy();

    // A different IP is a different bucket and still has its full budget.
    const other = await request.get('/api/p/aquawolf/operations', {
      headers: { 'x-vercel-forwarded-for': ip(2, testInfo.retry) },
    });
    expect(other.status()).toBe(200);
  });

  test('tRPC buckets are per procedure, not per IP alone', async ({ request }, testInfo) => {
    const mine = { 'x-vercel-forwarded-for': ip(3, testInfo.retry) };

    const statuses = await flood(request, '/api/trpc/health', BUCKET_LIMIT, mine);
    expect(statuses.every((s) => s === 200)).toBeTruthy();

    const limited = await request.get('/api/trpc/health', { headers: mine });
    expect(limited.status()).toBe(429);

    // Same IP, different procedure: `lib/server/trpc.ts` keys the bucket
    // `${ip}:${path}`, so this one is untouched.
    const otherProcedure = await request.get('/api/trpc/registry.count', { headers: mine });
    expect(otherProcedure.status()).toBe(200);
  });

  test('callers with no platform header share one bounded UNKNOWN_IP bucket', async ({
    request,
  }, testInfo) => {
    // Deliberately no assertion that the bucket starts empty: it is shared with
    // every other unheadered caller, and specs run in parallel. What matters is
    // that it is enforced rather than silently unlimited.
    const statuses = await flood(request, '/api/p/somebody/operations', BUCKET_LIMIT + 5);
    expect(statuses).toContain(429);

    // An untrusted X-Forwarded-For must not buy a private bucket: with
    // SIGNET_TRUSTED_PROXY_HOPS unset, it is ignored and this still lands in
    // the same exhausted `unknown` bucket.
    const spoofed = await request.get('/api/p/somebody/operations', {
      headers: { 'x-forwarded-for': '192.168.1.1' },
    });
    expect(spoofed.status()).toBe(429);

    // ...while a real platform header does get its own bucket, proving the
    // 429s above were attribution and not a global outage.
    const attributed = await request.get('/api/p/somebody/operations', {
      headers: { 'x-vercel-forwarded-for': ip(4, testInfo.retry) },
    });
    expect(attributed.status()).toBe(200);
  });
});
