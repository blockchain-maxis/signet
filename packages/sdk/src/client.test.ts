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
  const client = new SignetClient({
    baseUrl: 'https://signet.dev',
    fetch: mockFetch({}, { ok: false, status: 500 }),
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
  const client = new SignetClient({ baseUrl: 'https://signet.dev', fetch: failing });
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
