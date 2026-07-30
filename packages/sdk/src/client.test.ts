import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignetClient } from './client.ts';

function mockFetch(payload: unknown, ok = true): typeof fetch {
  return (async (url: string | URL | Request) => {
    return {
      ok,
      status: ok ? 200 : 500,
      url: String(url),
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
}

test('getProfile unwraps the tRPC result envelope', async () => {
  const data = { handle: 'aquawolf', profile: { name: 'Aqua Wolf' }, stats: { invocations: 2 } };
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: mockFetch({ result: { data } }) });
  const res = await client.getProfile('aquawolf');
  assert.deepEqual(res, data);
});

test('getProfile encodes the handle into the input query', async () => {
  let seen = '';
  const fetchSpy = (async (url: string) => {
    seen = String(url);
    return { ok: true, status: 200, json: async () => ({ result: { data: null } }) } as Response;
  }) as unknown as typeof fetch;
  const client = new SignetClient({ baseUrl: 'https://signet.dev/', fetch: fetchSpy });
  await client.getProfile('aquawolf');
  assert.ok(seen.includes('/api/trpc/profile.byHandle'));
  assert.ok(seen.includes(encodeURIComponent('{"handle":"aquawolf"}')));
});

test('getProfile returns null on a non-OK response', async () => {
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: mockFetch({}, false) });
  assert.equal(await client.getProfile('ghost'), null);
});

test('listHandles defaults to an empty array', async () => {
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: mockFetch({ result: { data: null } }) });
  assert.deepEqual(await client.listHandles(), []);
});

test('retries on 5xx then succeeds on the next attempt', async () => {
  let callCount = 0;
  const flakyFetch = (async () => {
    callCount++;
    if (callCount < 3) {
      return { ok: false, status: 502, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ result: { data: { handle: 'persistent' } } }) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: flakyFetch, maxRetries: 3, timeoutMs: 5000 });
  const res = await client.getProfile('persistent');
  assert.deepEqual(res, { handle: 'persistent' });
  assert.equal(callCount, 3);
});

test('returns null when retries are exhausted on 5xx', async () => {
  const alwaysFail = (async () => {
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: alwaysFail, maxRetries: 1, timeoutMs: 5000 });
  const res = await client.getProfile('ghost');
  assert.equal(res, null);
});

test('handles timeout via AbortController (aborted fetch returns null)', async () => {
  // A fetch that never resolves (signals aborted, returns null)
  const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    // Wait for the signal to abort, then reject
    await new Promise((_, reject) => {
      if (init?.signal) {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }
    });
    // unreachable
    return null as unknown as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: hangingFetch, timeoutMs: 50, maxRetries: 0 });
  const res = await client.getProfile('timeout');
  assert.equal(res, null);
});

test('custom timeoutMs and maxRetries are applied', () => {
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    timeoutMs: 5_000,
    maxRetries: 3,
  });
  // Access private fields via bracket notation to verify
  assert.equal((client as unknown as Record<string, unknown>).timeoutMs, 5_000);
  assert.equal((client as unknown as Record<string, unknown>).maxRetries, 3);
});
