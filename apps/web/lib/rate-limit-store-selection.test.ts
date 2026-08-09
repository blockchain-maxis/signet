import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, __resetRateLimit } from './rate-limit.ts';

/**
 * `ensureStore()` in rate-limit.ts auto-upgrades from the in-memory store to
 * `UpstashRateLimitStore` the first time it sees both Redis env vars set, and
 * stays on memory otherwise. These tests drive that selection through the
 * public `rateLimit()` entry point (rather than reaching into module
 * internals) and observe it via whether `fetch` — the Redis store's only
 * side effect — got called.
 */

test('selects the Redis store once both Upstash env vars are present', async (t) => {
  __resetRateLimit();
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  t.after(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimit();
  });

  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => [{ result: 1 }, { result: null }, { result: 60_000 }],
  }));
  t.after(() => fetchMock.mock.restore());

  await rateLimit('selection:redis');

  assert.equal(fetchMock.mock.calls.length, 1);
});

test('stays on the in-memory store when Redis env vars are absent', async (t) => {
  __resetRateLimit();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  t.after(() => __resetRateLimit());

  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not be called — memory store must not touch the network');
  });
  t.after(() => fetchMock.mock.restore());

  const result = await rateLimit('selection:memory');

  assert.equal(result.ok, true);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('an explicit setRateLimitStore() call is not overridden by env auto-detection', async (t) => {
  const { setRateLimitStore } = await import('./rate-limit.ts');
  __resetRateLimit();
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  t.after(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimit();
  });

  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not be called — an explicit store must win over env detection');
  });
  t.after(() => fetchMock.mock.restore());

  setRateLimitStore({ hit: async () => ({ ok: true, remaining: 9, resetMs: 1000 }) });
  const result = await rateLimit('selection:explicit');

  assert.deepEqual(result, { ok: true, remaining: 9, resetMs: 1000 });
  assert.equal(fetchMock.mock.calls.length, 0);
});
