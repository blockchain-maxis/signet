import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { UpstashRateLimitStore } from './rate-limit-redis.ts';

/** Mock the global `fetch` with a canned Upstash pipeline response. */
function mockPipeline(body: unknown, ok = true) {
  return mock.method(globalThis, 'fetch', async () => ({
    ok,
    json: async () => body,
  }));
}

test('hit() allows under the max and reports remaining/reset from the pipeline reply', async (t) => {
  const fetchMock = mockPipeline([{ result: 3 }, { result: null }, { result: 45_000 }]);
  t.after(() => fetchMock.mock.restore());

  const result = await new UpstashRateLimitStore('https://example.upstash.io', 'tok').hit(
    'ip:test',
    5,
    60_000,
  );

  assert.deepEqual(result, { ok: true, remaining: 2, resetMs: 45_000 });
});

test('hit() blocks once the pipeline count exceeds the max', async (t) => {
  const fetchMock = mockPipeline([{ result: 6 }, { result: null }, { result: 12_000 }]);
  t.after(() => fetchMock.mock.restore());

  const result = await new UpstashRateLimitStore('https://example.upstash.io', 'tok').hit(
    'ip:test',
    5,
    60_000,
  );

  assert.equal(result.ok, false);
  assert.equal(result.remaining, 0);
});

test('hit() sends an INCR/PEXPIRE NX/PTTL pipeline against the namespaced key', async (t) => {
  const fetchMock = mockPipeline([{ result: 1 }, { result: null }, { result: 60_000 }]);
  t.after(() => fetchMock.mock.restore());

  await new UpstashRateLimitStore('https://example.upstash.io/', 'secret-token').hit(
    'ip:1.2.3.4',
    5,
    60_000,
  );

  assert.equal(fetchMock.mock.calls.length, 1);
  const [url, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
  assert.equal(url, 'https://example.upstash.io/pipeline'); // trailing slash stripped
  assert.equal((init.headers as Record<string, string>).authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(init.body as string), [
    ['INCR', 'ratelimit:ip:1.2.3.4'],
    ['PEXPIRE', 'ratelimit:ip:1.2.3.4', 60_000, 'NX'],
    ['PTTL', 'ratelimit:ip:1.2.3.4'],
  ]);
});

test('hit() fails open when the HTTP response is not ok', async (t) => {
  const fetchMock = mockPipeline([], false);
  t.after(() => fetchMock.mock.restore());

  const result = await new UpstashRateLimitStore('https://example.upstash.io', 'tok').hit(
    'ip:test',
    5,
    60_000,
  );

  assert.equal(result.ok, true);
});

test('hit() fails open when fetch throws (network error)', async (t) => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  t.after(() => fetchMock.mock.restore());

  const result = await new UpstashRateLimitStore('https://example.upstash.io', 'tok').hit(
    'ip:test',
    5,
    60_000,
  );

  assert.equal(result.ok, true);
});
