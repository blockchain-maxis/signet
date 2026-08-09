import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignetClient } from './client.ts';
import { ApiError, NetworkError } from './errors.ts';

function mockFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}): typeof fetch {
  const { ok = true, status = 200 } = opts;
  return (async (url: string | URL | Request) => {
    return {
      ok,
      status,
      url: String(url),
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
}

test('getProfile unwraps the tRPC result envelope', async () => {
  const data = { handle: 'aquawolf', profile: { name: 'Aqua Wolf' }, stats: { invocations: 2 } };
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: mockFetch({ result: { data } }),
  });
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

test('getProfile returns null on a 404 (not found)', async () => {
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: mockFetch({}, { ok: false, status: 404 }),
  });
  assert.equal(await client.getProfile('ghost'), null);
});

test('getProfile throws ApiError carrying the status on a server error', async () => {
  // `maxRetries: 0` keeps this about the error mapping — retry behaviour on 5xx
  // has its own tests below, and the default would add backoff delay here.
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: mockFetch({}, { ok: false, status: 500 }),
    maxRetries: 0,
  });
  await assert.rejects(
    () => client.getProfile('x'),
    (err: unknown) => err instanceof ApiError && err.status === 500,
  );
});

test('getProfile throws NetworkError when the request never reaches the server', async () => {
  const failing = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: failing, maxRetries: 0 });
  await assert.rejects(
    () => client.getProfile('x'),
    (err: unknown) => err instanceof NetworkError,
  );
});

test('listHandles defaults to an empty array', async () => {
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: mockFetch({ result: { data: null } }),
  });
  assert.deepEqual(await client.listHandles(), []);
});

test('resolveHandle calls registry.resolve and unwraps the result', async () => {
  const data = { handle: 'aquawolf', wallet: 'GAAA...' };
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: mockFetch({ result: { data } }) });
  const res = await client.resolveHandle('aquawolf');
  assert.deepEqual(res, data);
});

test('resolveHandle encodes the handle into the procedure URL', async () => {
  let seen = '';
  const fetchSpy = (async (url: string) => {
    seen = String(url);
    return { ok: true, json: async () => ({ result: { data: null } }) } as Response;
  }) as unknown as typeof fetch;
  const client = new SignetClient({ baseUrl: 'https://signet.dev/', fetch: fetchSpy });
  await client.resolveHandle('aquawolf');
  assert.ok(seen.includes('/api/trpc/registry.resolve'));
  assert.ok(seen.includes(encodeURIComponent('{"handle":"aquawolf"}')));
});

test('resolveHandle returns null on a 404 (unregistered)', async () => {
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: mockFetch({}, { ok: false, status: 404 }),
  });
  assert.equal(await client.resolveHandle('ghost'), null);
});

test('resolveHandle throws ApiError on a server error', async () => {
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: mockFetch({}, { ok: false, status: 503 }),
  });
  await assert.rejects(
    () => client.resolveHandle('ghost'),
    (err: unknown) => err instanceof ApiError && err.status === 503,
  );
});

test('lookupWallet calls registry.lookup', async () => {
  const data = { handle: 'aquawolf', wallet: 'GAAA...' };
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: mockFetch({ result: { data } }) });
  const res = await client.lookupWallet('GAAA...');
  assert.deepEqual(res, data);
});

test('lookupWallet encodes the wallet into the procedure URL', async () => {
  let seen = '';
  const fetchSpy = (async (url: string) => {
    seen = String(url);
    return { ok: true, json: async () => ({ result: { data: null } }) } as Response;
  }) as unknown as typeof fetch;
  const client = new SignetClient({ baseUrl: 'https://signet.dev/', fetch: fetchSpy });
  await client.lookupWallet('GABCDEF');
  assert.ok(seen.includes('/api/trpc/registry.lookup'));
  assert.ok(seen.includes(encodeURIComponent('{"wallet":"GABCDEF"}')));
});

test('countRegistryEntries calls registry.count', async () => {
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: mockFetch({ result: { data: { count: 42 } } }) });
  const res = await client.countRegistryEntries();
  assert.deepEqual(res, { count: 42 });
});

test('countRegistryEntries defaults to zero when the response is null', async () => {
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: mockFetch({ result: { data: null } }) });
  const res = await client.countRegistryEntries();
  assert.deepEqual(res, { count: 0 });
});

// ── Timeout + retry ─────────────────────────────────────────────────────────

test('retries a 5xx and returns the result from a later attempt', async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 502, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => ({ result: { data: ['aquawolf'] } }) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: flaky, maxRetries: 3 });
  assert.deepEqual(await client.listHandles(), ['aquawolf']);
  assert.equal(calls, 3);
});

test('surfaces ApiError once the 5xx retries are exhausted', async () => {
  let calls = 0;
  const alwaysDown = (async () => {
    calls++;
    return { ok: false, status: 503, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: alwaysDown, maxRetries: 1 });
  await assert.rejects(
    () => client.listHandles(),
    (err: unknown) => err instanceof ApiError && err.status === 503,
  );
  assert.equal(calls, 2, 'initial attempt plus one retry');
});

test('does not retry a 4xx — it is an answer, not a glitch', async () => {
  let calls = 0;
  const badRequest = (async () => {
    calls++;
    return { ok: false, status: 400, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: badRequest, maxRetries: 3 });
  await assert.rejects(() => client.listHandles(), (err: unknown) => err instanceof ApiError);
  assert.equal(calls, 1);
});

test('does not retry a 404', async () => {
  let calls = 0;
  const missing = (async () => {
    calls++;
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: missing, maxRetries: 3 });
  assert.equal(await client.getProfile('ghost'), null);
  assert.equal(calls, 1);
});

test('aborts a stalled request and rejects with NetworkError', async () => {
  // Resolves only if aborted — i.e. the client, not the server, ends the call.
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')),
      );
    })) as unknown as typeof fetch;

  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: hanging,
    timeoutMs: 20,
    maxRetries: 0,
  });
  await assert.rejects(
    () => client.listHandles(),
    (err: unknown) => err instanceof NetworkError && /timed out after 20ms/.test((err as Error).message),
  );
});

test('retries a transient network failure and then succeeds', async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => ({ result: { data: { count: 7 } } }) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: flaky, maxRetries: 2 });
  assert.deepEqual(await client.countRegistryEntries(), { count: 7 });
  assert.equal(calls, 2);
});

test('timeout and retry options default when not supplied', async () => {
  let seenSignal: AbortSignal | undefined;
  const spy = (async (_url: string | URL | Request, init?: RequestInit) => {
    seenSignal = init?.signal ?? undefined;
    return { ok: true, status: 200, json: async () => ({ result: { data: [] } }) } as Response;
  }) as unknown as typeof fetch;

  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: spy });
  await client.listHandles();
  assert.ok(seenSignal instanceof AbortSignal, 'every request carries an abort signal');
  assert.equal(seenSignal?.aborted, false);
});
