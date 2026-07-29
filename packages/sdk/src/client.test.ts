import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignetClient } from './client.ts';

function mockFetch(payload: unknown, ok = true): typeof fetch {
  return (async (url: string | URL | Request) => {
    return {
      ok,
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
    return { ok: true, json: async () => ({ result: { data: null } }) } as Response;
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

// ── Timeout ─────────────────────────────────────────────────────────────────

test('query returns null when the request times out', async () => {
  let abortSignal: AbortSignal | null = null;
  const timeoutOnAbort = (async (_url: string, init: RequestInit) => {
    abortSignal = init.signal ?? null;
    // Wait for the signal to be aborted, then reject like real fetch does
    return new Promise<Response>((_resolve, reject) => {
      if (init.signal) {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }
    });
  }) as unknown as typeof fetch;

  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: timeoutOnAbort,
    timeout: 50, // very short timeout
    retries: 0,  // no retries to keep the test fast
  });

  assert.equal(await client.getProfile('aquawolf'), null);
  // The signal should have been aborted by the timeout
  assert.ok(abortSignal?.aborted);
});

test('query returns null on a non-5xx error without retrying', async () => {
  let callCount = 0;
  const failWith400 = (async () => {
    callCount++;
    return { ok: false, status: 400, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: failWith400,
    retries: 2,
  });

  assert.equal(await client.getProfile('ghost'), null);
  assert.equal(callCount, 1); // no retry on 4xx
});

// ── Retry on 5xx ────────────────────────────────────────────────────────────

test('query retries on 5xx and succeeds on the next attempt', async () => {
  let callCount = 0;
  const failOnce = (async () => {
    callCount++;
    if (callCount === 1) {
      return { ok: false, status: 502, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({ result: { data: { handle: 'aquawolf' } } }) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: failOnce,
    retries: 2,
  });

  const res = await client.getProfile('aquawolf');
  assert.deepEqual(res, { handle: 'aquawolf' });
  assert.equal(callCount, 2); // first failed, second succeeded
});

test('query returns null after exhausting retries on 5xx', async () => {
  let callCount = 0;
  const always500 = (async () => {
    callCount++;
    return { ok: false, status: 500, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: always500,
    retries: 2,
  });

  assert.equal(await client.getProfile('ghost'), null);
  // initial call + 2 retries = 3 total
  assert.equal(callCount, 3);
});

test('query retries on transient network error and succeeds', async () => {
  let callCount = 0;
  const failOnce = (async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error('network error');
    }
    return { ok: true, json: async () => ({ result: { data: { handle: 'aquawolf' } } }) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: failOnce,
    retries: 2,
    timeout: 5000,
  });

  const res = await client.getProfile('aquawolf');
  assert.deepEqual(res, { handle: 'aquawolf' });
  assert.equal(callCount, 2);
});

test('custom timeout and retries are accepted', () => {
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    timeout: 5000,
    retries: 5,
  });
  assert.ok(client instanceof SignetClient);
});
