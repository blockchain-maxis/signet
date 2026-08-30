import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PNA_REQUEST_HEADER, PNA_RESPONSE_HEADER } from './loopback-cors.ts';
import { LoopbackTimeoutError, startLoopbackServer } from './loopback.ts';

const DEPLOYMENT = 'https://signet.dev';

test('answers a Chrome PNA preflight and then accepts the callback', async () => {
  const handle = await startLoopbackServer({ deploymentOrigin: DEPLOYMENT });

  // 1. The preflight Chrome sends because this is a public -> private request.
  const preflight = await fetch(handle.url, {
    method: 'OPTIONS',
    headers: {
      origin: DEPLOYMENT,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
      [PNA_REQUEST_HEADER]: 'true',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get(PNA_RESPONSE_HEADER), 'true');
  assert.equal(preflight.headers.get('access-control-allow-origin'), DEPLOYMENT);

  // 2. The callback itself.
  const posted = await fetch(handle.url, {
    method: 'POST',
    headers: { origin: DEPLOYMENT, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'pair-123', approved: true }),
  });
  assert.equal(posted.status, 200);
  assert.equal(posted.headers.get('access-control-allow-origin'), DEPLOYMENT);

  assert.deepEqual((await handle.result).payload, { code: 'pair-123', approved: true });
  await handle.close();
});

test('binds loopback only', async () => {
  const handle = await startLoopbackServer({ deploymentOrigin: DEPLOYMENT });
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  await handle.close();
});

test('refuses a callback from a foreign origin, and says so', async () => {
  const refusals: string[] = [];
  const handle = await startLoopbackServer({
    deploymentOrigin: DEPLOYMENT,
    onRefusal: (m) => refusals.push(m),
  });

  const res = await fetch(handle.url, {
    method: 'POST',
    headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'stolen' }),
  });

  // Re-checked on the real request: a preflight is a browser courtesy, and
  // anything that is not a browser simply skips it.
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(refusals.length, 1);
  assert.match(refusals[0] ?? '', /evil\.test/);
  await handle.close();
});

test('rejects a non-POST, non-OPTIONS method', async () => {
  const handle = await startLoopbackServer({ deploymentOrigin: DEPLOYMENT });
  const res = await fetch(handle.url, { method: 'GET', headers: { origin: DEPLOYMENT } });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
  await handle.close();
});

test('reports a malformed body instead of hanging on it', async () => {
  const handle = await startLoopbackServer({ deploymentOrigin: DEPLOYMENT });
  const res = await fetch(handle.url, {
    method: 'POST',
    headers: { origin: DEPLOYMENT, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  await handle.close();
});

test('is single-use: a second callback finds the server closed', async () => {
  const handle = await startLoopbackServer({ deploymentOrigin: DEPLOYMENT });
  const url = handle.url;

  await fetch(url, {
    method: 'POST',
    headers: { origin: DEPLOYMENT, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'first' }),
  });
  await handle.result;

  // The port is released after the one answer it was waiting for.
  await assert.rejects(
    fetch(url, {
      method: 'POST',
      headers: { origin: DEPLOYMENT, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'second' }),
    }),
  );
});

test('times out with a real error rather than waiting forever', async () => {
  const handle = await startLoopbackServer({ deploymentOrigin: DEPLOYMENT, timeoutMs: 50 });
  // The CLI must be able to say "the browser never called back", not sit at a
  // spinner until the developer gives up.
  await assert.rejects(handle.result, (err: unknown) => {
    assert.ok(err instanceof LoopbackTimeoutError);
    assert.match((err as Error).message, /no callback received/);
    return true;
  });
});
