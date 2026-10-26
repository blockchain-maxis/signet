import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignetClient } from './client.ts';
import {
  ApiError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
} from './errors.ts';

const BASE = 'https://signet.dev';
const WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers each call with the next reply and records what it was asked. */
function mockFetch(...replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = replies[Math.min(calls.length, replies.length) - 1]!;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const v1Error = (code: string, message: string, details?: Record<string, unknown>) => ({
  error: { code, message, ...(details ? { details } : {}) },
});

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new SignetClient({ baseUrl: `${BASE}/`, fetch: fetchImpl, ...extra });
}

const profile = {
  handle: 'alice',
  displayName: 'Alice',
  bio: null,
  avatarUrl: null,
  primaryWallet: WALLET,
  wallets: [],
  counts: { contracts: 2, wallets: 1, invocations: 9 },
  countsAreLowerBounds: false,
  joinedAt: '2026-01-01T00:00:00.000Z',
  archived: false,
  network: 'testnet',
};

// ── Methods ─────────────────────────────────────────────────────────────────

test('getProfile reads /api/v1/profiles/{handle} and returns the v1 data', async () => {
  const { fetchImpl, calls } = mockFetch({
    body: { data: profile, meta: { network: 'testnet', source: 'database' } },
  });
  assert.deepEqual(await client(fetchImpl).getProfile('alice'), profile);
  assert.equal(calls[0]!.url, `${BASE}/api/v1/profiles/alice`);
  assert.equal(calls[0]!.headers.accept, 'application/json');
});

test('getProfile returns null on a 404, and escapes the handle', async () => {
  const { fetchImpl, calls } = mockFetch({
    status: 404,
    body: v1Error('not_found', "No profile for handle 'a/b'."),
  });
  assert.equal(await client(fetchImpl).getProfile('a/b'), null);
  assert.equal(calls[0]!.url, `${BASE}/api/v1/profiles/a%2Fb`);
});

test('resolveHandle reads /api/v1/resolve/{handle}', async () => {
  const { fetchImpl, calls } = mockFetch({
    body: {
      data: { handle: 'alice', wallet: WALLET, network: 'testnet', registryContract: 'C…' },
    },
  });
  assert.deepEqual(await client(fetchImpl).resolveHandle('alice'), {
    handle: 'alice',
    wallet: WALLET,
  });
  assert.equal(calls[0]!.url, `${BASE}/api/v1/resolve/alice`);
});

test('resolveHandle returns null when the handle is not bound', async () => {
  const { fetchImpl } = mockFetch({ status: 404, body: v1Error('not_found', 'unbound') });
  assert.equal(await client(fetchImpl).resolveHandle('ghost'), null);
});

test('lookupWallet reads /api/v1/lookup/{address}; an unlinked wallet is null', async () => {
  const linked = mockFetch({
    body: {
      data: {
        address: WALLET,
        handle: 'alice',
        source: 'cli',
        isPrimary: false,
        network: 'testnet',
      },
      meta: { source: 'database' },
    },
  });
  assert.deepEqual(await client(linked.fetchImpl).lookupWallet(WALLET), {
    handle: 'alice',
    wallet: WALLET,
  });
  assert.equal(linked.calls[0]!.url, `${BASE}/api/v1/lookup/${WALLET}`);

  const unlinked = mockFetch({
    body: {
      data: { address: WALLET, handle: null, source: null, isPrimary: false, network: 'testnet' },
      meta: { source: 'chain' },
    },
  });
  assert.equal(await client(unlinked.fetchImpl).lookupWallet(WALLET), null);
});

test('countRegistryEntries reads boundHandles from /api/v1/registry/stats', async () => {
  const stats = (boundHandles: number | null) =>
    mockFetch({
      body: {
        data: { boundHandles, indexedContracts: null, indexedWallets: null, network: 'testnet' },
      },
    });
  const known = stats(42);
  assert.deepEqual(await client(known.fetchImpl).countRegistryEntries(), { count: 42 });
  assert.equal(known.calls[0]!.url, `${BASE}/api/v1/registry/stats`);
  assert.deepEqual(await client(stats(null).fetchImpl).countRegistryEntries(), { count: 0 });
});

test('listHandles still reads the deprecated tRPC route', async () => {
  const { fetchImpl, calls } = mockFetch({ body: { result: { data: ['alice'] } } });
  assert.deepEqual(await client(fetchImpl).listHandles(), ['alice']);
  assert.equal(calls[0]!.url, `${BASE}/api/trpc/profile.list`);
  const empty = mockFetch({ body: { result: { data: null } } });
  assert.deepEqual(await client(empty.fetchImpl).listHandles(), []);
});

test('request builds the query string and returns the whole envelope', async () => {
  const { fetchImpl, calls } = mockFetch({ body: { data: [], meta: { nextCursor: null } } });
  const res = await client(fetchImpl).request('/profiles/alice/contracts', {
    query: { limit: 10, cursor: undefined, other: null },
  });
  assert.deepEqual(res, { data: [], meta: { nextCursor: null } });
  assert.equal(calls[0]!.url, `${BASE}/api/v1/profiles/alice/contracts?limit=10`);
});

test('apiKey is sent as a Bearer token; without one there is no Authorization', async () => {
  const keyed = mockFetch({ body: { data: profile } });
  await client(keyed.fetchImpl, { apiKey: 'sgk_test_123' }).getProfile('alice');
  assert.equal(keyed.calls[0]!.headers.authorization, 'Bearer sgk_test_123');
  const anonymous = mockFetch({ body: { data: profile } });
  await client(anonymous.fetchImpl).getProfile('alice');
  assert.equal('authorization' in anonymous.calls[0]!.headers, false);
});

// ── Error mapping ───────────────────────────────────────────────────────────

test('a 400 is a ValidationError with the code and the parameter', async () => {
  const { fetchImpl, calls } = mockFetch({
    status: 400,
    body: v1Error('bad_request', 'Invalid handle "A B".', { parameter: 'handle' }),
  });
  await assert.rejects(client(fetchImpl, { maxRetries: 3 }).getProfile('A B'), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'bad_request');
    assert.equal(err.parameter, 'handle');
    assert.equal(err.message, 'Invalid handle "A B".');
    return true;
  });
  assert.equal(calls.length, 1, 'a 4xx is an answer, not retried');
});

test('a 404 outside the nullable lookups is a NotFoundError with its code', async () => {
  const { fetchImpl } = mockFetch({ status: 404, body: v1Error('not_found', 'nope') });
  await assert.rejects(client(fetchImpl).request('/profiles/ghost/wallets'), (err: unknown) => {
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.code, 'not_found');
    return true;
  });
});

test('a 429 waits out a short Retry-After and retries', async () => {
  const { fetchImpl, calls } = mockFetch(
    { status: 429, body: v1Error('rate_limited', 'slow down'), headers: { 'retry-after': '0' } },
    { body: { data: profile } },
  );
  assert.deepEqual(await client(fetchImpl).getProfile('alice'), profile);
  assert.equal(calls.length, 2);
});

test('a 429 with a long Retry-After surfaces as RateLimitedError at once', async () => {
  const { fetchImpl, calls } = mockFetch({
    status: 429,
    body: v1Error('rate_limited', 'Too many requests. Retry in 30 seconds.'),
    headers: { 'retry-after': '30' },
  });
  await assert.rejects(client(fetchImpl).getProfile('alice'), (err: unknown) => {
    assert.ok(err instanceof RateLimitedError);
    assert.equal(err.retryAfterSeconds, 30);
    assert.equal(err.code, 'rate_limited');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('a 429 is retried only while retries remain, then surfaces', async () => {
  const { fetchImpl, calls } = mockFetch({
    status: 429,
    body: v1Error('rate_limited', 'slow down'),
    headers: { 'retry-after': '0' },
  });
  await assert.rejects(
    client(fetchImpl, { maxRetries: 1 }).getProfile('alice'),
    (err: unknown) => err instanceof RateLimitedError && err.retryAfterSeconds === 0,
  );
  assert.equal(calls.length, 2);
  // Without a Retry-After the client does not guess.
  const bare = mockFetch({ status: 429, body: v1Error('rate_limited', 'slow down') });
  await assert.rejects(
    client(bare.fetchImpl).getProfile('alice'),
    (err: unknown) => err instanceof RateLimitedError && err.retryAfterSeconds === null,
  );
  assert.equal(bare.calls.length, 1);
});

test('a 503 is retried, then surfaces as UnavailableError', async () => {
  const { fetchImpl, calls } = mockFetch({
    status: 503,
    body: v1Error('unavailable', 'Could not look this address up.'),
  });
  await assert.rejects(
    client(fetchImpl, { maxRetries: 1 }).lookupWallet(WALLET),
    (err: unknown) => err instanceof UnavailableError && err.code === 'unavailable',
  );
  assert.equal(calls.length, 2, 'initial attempt plus one retry');
});

test('any other status is an ApiError carrying status and code', async () => {
  const { fetchImpl } = mockFetch({
    status: 500,
    body: v1Error('internal', 'Something went wrong. Try again later.'),
  });
  await assert.rejects(client(fetchImpl, { maxRetries: 0 }).getProfile('alice'), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    assert.equal(err.code, 'internal');
    return true;
  });
});

test('an error body that is not JSON still maps by status', async () => {
  const html = (async () =>
    new Response('<html>Bad gateway</html>', { status: 502 })) as typeof fetch;
  await assert.rejects(
    client(html, { maxRetries: 0 }).getProfile('alice'),
    (err: unknown) =>
      err instanceof ApiError &&
      err.status === 502 &&
      err.code === undefined &&
      /502/.test(err.message),
  );
});

// ── Timeout + retry ─────────────────────────────────────────────────────────

test('retries a 5xx and returns the result from a later attempt', async () => {
  const { fetchImpl, calls } = mockFetch(
    { status: 502 },
    { status: 502 },
    { body: { data: profile } },
  );
  assert.deepEqual(await client(fetchImpl, { maxRetries: 3 }).getProfile('alice'), profile);
  assert.equal(calls.length, 3);
});

test('does not retry a 404', async () => {
  const { fetchImpl, calls } = mockFetch({ status: 404, body: v1Error('not_found', 'no') });
  assert.equal(await client(fetchImpl, { maxRetries: 3 }).getProfile('ghost'), null);
  assert.equal(calls.length, 1);
});

test('getProfile throws NetworkError when the request never reaches the server', async () => {
  const failing = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  await assert.rejects(
    client(failing, { maxRetries: 0 }).getProfile('x'),
    (err: unknown) => err instanceof NetworkError,
  );
});

test('aborts a stalled request and rejects with NetworkError', async () => {
  // Resolves only if aborted — i.e. the client, not the server, ends the call.
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')),
      );
    })) as unknown as typeof fetch;

  await assert.rejects(
    client(hanging, { timeoutMs: 20, maxRetries: 0 }).getProfile('alice'),
    (err: unknown) =>
      err instanceof NetworkError && /timed out after 20ms/.test((err as Error).message),
  );
});

test('retries a transient network failure and then succeeds', async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ data: { boundHandles: 7, network: 'testnet' } }));
  }) as unknown as typeof fetch;
  assert.deepEqual(await client(flaky, { maxRetries: 2 }).countRegistryEntries(), { count: 7 });
  assert.equal(calls, 2);
});

test('every request carries an abort signal', async () => {
  let seenSignal: AbortSignal | undefined;
  const spy = (async (_url: string | URL | Request, init?: RequestInit) => {
    seenSignal = init?.signal ?? undefined;
    return new Response(JSON.stringify({ data: profile }));
  }) as unknown as typeof fetch;
  await client(spy).getProfile('alice');
  assert.ok(seenSignal instanceof AbortSignal);
  assert.equal(seenSignal?.aborted, false);
});
