import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkClient, SignetLinkError, type DevicePair, type LinkStatus } from './link-client.ts';

function jsonResponse(payload: unknown, opts: { ok?: boolean; status?: number } = {}): Response {
  const { ok = true, status = 200 } = opts;
  return { ok, status, json: async () => payload } as Response;
}

/** Mock fetch that records the URL + init and answers from a queue. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return (async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init)) as unknown as typeof fetch;
}

test('createDevice POSTs to /api/link/device and returns the pairing', async () => {
  const pair: DevicePair = { pairingCode: 'XXXX', verificationUrl: 'http://h/link/XXXX', ttlMs: 5 * 60_000, intervalMs: 2000 };
  let seenUrl = '';
  const client = new LinkClient('http://localhost:3000', {
    fetch: mockFetch((url, init) => {
      seenUrl = url;
      assert.equal(init?.method, 'POST');
      return jsonResponse(pair);
    }),
  });
  const res = await client.createDevice();
  assert.equal(seenUrl, 'http://localhost:3000/api/link/device');
  assert.deepEqual(res, pair);
});

test('getStatus GETs the status endpoint with the pairing code', async () => {
  let seenUrl = '';
  const client = new LinkClient('http://localhost:3000', {
    fetch: mockFetch((url) => {
      seenUrl = url;
      return jsonResponse({ state: 'pending' } satisfies LinkStatus);
    }),
  });
  const res = await client.getStatus('AB12CD34');
  assert.equal(seenUrl, 'http://localhost:3000/api/link/device/status?code=AB12CD34');
  assert.deepEqual(res, { state: 'pending' });
});

test('a non-OK response becomes a SignetLinkError carrying the status', async () => {
  const client = new LinkClient('http://localhost:3000', {
    fetch: mockFetch(() => jsonResponse({}, { ok: false, status: 429 })),
  });
  await assert.rejects(
    () => client.createDevice(),
    (err: unknown) => err instanceof SignetLinkError && err.status === 429,
  );
});

test('a network failure becomes a SignetLinkError, never a hang', async () => {
  const client = new LinkClient('http://localhost:3000', {
    fetch: mockFetch(() => {
      throw new TypeError('fetch failed');
    }),
  });
  await assert.rejects(
    () => client.createDevice(),
    (err: unknown) => err instanceof SignetLinkError && /failed/.test((err as Error).message),
  );
});

test('a stalled server is aborted and surfaces as a timeout', async () => {
  const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')),
      );
    })) as unknown as typeof fetch;
  const client = new LinkClient('http://localhost:3000', { fetch: hanging, timeoutMs: 20 });
  await assert.rejects(
    () => client.createDevice(),
    (err: unknown) => err instanceof SignetLinkError && /timed out after 20ms/.test((err as Error).message),
  );
});

test('baseUrl normalizes away a trailing slash', () => {
  const client = new LinkClient('http://localhost:3000/', { fetch: mockFetch(() => jsonResponse({})) });
  assert.equal(client.baseUrl, 'http://localhost:3000');
});