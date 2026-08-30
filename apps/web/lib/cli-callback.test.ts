import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postToCli, type CliCallbackResult } from './cli-callback.ts';

const URL_ = 'http://127.0.0.1:53421';

function fetchReturning(res: Partial<Response>): typeof fetch {
  return (async () => res as Response) as unknown as typeof fetch;
}

test('reports success when the CLI accepts the callback', async () => {
  const result = await postToCli(
    URL_,
    { code: 'abc' },
    {
      fetchImpl: fetchReturning({ ok: true, status: 200 }),
    },
  );
  assert.deepEqual(result, { ok: true });
});

test('names the browser block instead of surfacing "Failed to fetch"', async () => {
  // A blocked cross-origin fetch — the PNA preflight being refused, in
  // practice — rejects with a bare TypeError carrying no detail at all.
  const result = (await postToCli(
    URL_,
    {},
    {
      fetchImpl: (() =>
        Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch,
    },
  )) as Exclude<CliCallbackResult, { ok: true }>;

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'blocked');
  assert.match(result.message, /Private Network Access/);
  // The message has to tell the developer what to do next, not just what broke.
  assert.match(result.message, /signet link/);
});

test('reports a timeout rather than waiting forever', async () => {
  const never: typeof fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;

  const result = (await postToCli(
    URL_,
    {},
    {
      fetchImpl: never,
      timeoutMs: 20,
    },
  )) as Exclude<CliCallbackResult, { ok: true }>;

  assert.equal(result.reason, 'timeout');
  assert.match(result.message, /did not answer/);
});

test('distinguishes a refusal from a block', async () => {
  for (const status of [400, 403]) {
    const result = (await postToCli(
      URL_,
      {},
      {
        fetchImpl: fetchReturning({ ok: false, status }),
      },
    )) as Exclude<CliCallbackResult, { ok: true }>;
    // The CLI answered — that is a different problem from the browser never
    // letting the request through, and a different thing to tell the developer.
    assert.equal(result.reason, 'refused');
  }
});

test('treats any other non-ok status as an unusable answer', async () => {
  const result = (await postToCli(
    URL_,
    {},
    {
      fetchImpl: fetchReturning({ ok: false, status: 500 }),
    },
  )) as Exclude<CliCallbackResult, { ok: true }>;
  assert.equal(result.reason, 'invalid-response');
});

test('never throws, whatever fetch does', async () => {
  for (const thrown of [new Error('boom'), 'a string', null]) {
    const result = await postToCli(
      URL_,
      {},
      {
        fetchImpl: (() => Promise.reject(thrown)) as unknown as typeof fetch,
      },
    );
    assert.equal(result.ok, false);
  }
});

test('requests cors mode so the response is readable', async () => {
  let seen: RequestInit | undefined;
  await postToCli(
    URL_,
    {},
    {
      fetchImpl: ((_u: string, init?: RequestInit) => {
        seen = init;
        return Promise.resolve({ ok: true, status: 200 } as Response);
      }) as unknown as typeof fetch,
    },
  );
  // `no-cors` would resolve opaquely and report success for a request the CLI
  // never accepted.
  assert.equal(seen?.mode, 'cors');
});
