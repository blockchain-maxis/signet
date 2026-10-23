import { test, expect, type APIRequestContext } from '@playwright/test';
import { LIMITS } from '../lib/rate-limit-policy.ts';

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
 *  1. `/api/p/<handle>/operations` can reach the database, the chain and
 *     Horizon, so 60 *sequential* requests overrun the 30s default test
 *     timeout. The handle is any valid string: the route answers 200 with an
 *     empty page for a handle nothing knows, and the limiter runs first
 *     either way. They are issued in
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

// Budgets come from the policy table itself so this spec cannot drift from it:
// `LIMITS.read` for /api/p/*/operations (also rate-limit.ts's MAX_PER_WINDOW),
// `LIMITS.contractOperations` for the contract operations route (#452, #462),
// and `LIMITS.v1Read` for the anonymous v1 REST reads (#625).
const BATCH = 15;
/** Any syntactically valid handle; whether it is bound does not matter here. */
const OPERATIONS_PATH = '/api/p/rate-limit-probe/operations';
/** Any valid contract strkey; the limiter runs before existence is checked. */
const CONTRACT_OPERATIONS_PATH =
  '/api/p/rate-limit-probe/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/operations';
const V1_READ_PATH = '/api/v1/profiles/rate-limit-probe';

/** Unique per test and per retry, so a burnt bucket is never reused. */
function ip(testId: number, retry: number): string {
  return `10.99.${retry}.${testId}`;
}

/**
 * The shared proof for one (path, limit) pair: a fresh per-test, per-retry IP
 * spends exactly `limit` requests (every answer in `okStatuses`), the next
 * request is refused with a 429 whose `retry-after` is at least 1 second, and
 * a different IP still has its own full budget.
 */
async function expectBucketEnforced(
  request: APIRequestContext,
  path: string,
  limit: number,
  testId: number,
  retry: number,
  okStatuses: number[] = [200],
): Promise<void> {
  const mine = { 'x-vercel-forwarded-for': ip(testId, retry) };

  const statuses = await flood(request, path, limit, mine);
  expect(statuses.every((s) => okStatuses.includes(s))).toBeTruthy();

  // Budget spent: the next call is refused, with a usable retry-after.
  const limited = await request.get(path, { headers: mine });
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()['retry-after'])).toBeGreaterThanOrEqual(1);

  // A different IP is a different bucket and still has its full budget.
  const other = await request.get(path, {
    headers: { 'x-vercel-forwarded-for': ip(testId + 100, retry) },
  });
  expect(okStatuses.includes(other.status())).toBeTruthy();
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

  test('the operations route enforces its bucket, per IP (LIMITS.read)', async ({
    request,
  }, testInfo) => {
    await expectBucketEnforced(request, OPERATIONS_PATH, LIMITS.read, 1, testInfo.retry);
  });

  test('tRPC buckets are per procedure, not per IP alone', async ({ request }, testInfo) => {
    const mine = { 'x-vercel-forwarded-for': ip(3, testInfo.retry) };

    // LIMITS.read is also the tRPC per-procedure budget (rate-limit.ts MAX_PER_WINDOW).
    const statuses = await flood(request, '/api/trpc/health', LIMITS.read, mine);
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
    const statuses = await flood(request, '/api/p/somebody/operations', LIMITS.read + 5);
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

  test('the contract operations route enforces its bucket (LIMITS.contractOperations)', async ({
    request,
  }, testInfo) => {
    // A handle/contract nothing knows answers 200 with an empty page or a 404
    // envelope depending on what backs the route here; the limiter runs first
    // either way, which is the behaviour under test.
    await expectBucketEnforced(
      request,
      CONTRACT_OPERATIONS_PATH,
      LIMITS.contractOperations,
      5,
      testInfo.retry,
      [200, 404],
    );
  });

  test('the v1 read routes enforce their bucket (LIMITS.v1Read)', async ({
    request,
  }, testInfo) => {
    // /api/v1/profiles/{handle} stands in for every withV1 read route: they
    // all share the v1Read bucket by default.
    await expectBucketEnforced(request, V1_READ_PATH, LIMITS.v1Read, 6, testInfo.retry, [200, 404]);
  });
});
