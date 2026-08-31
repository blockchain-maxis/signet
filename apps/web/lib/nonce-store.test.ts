import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeNonce,
  getNonceStoreStatus,
  setNonceStore,
  __resetNonceStore,
  UpstashNonceStore,
} from './nonce-store.ts';

test('consumeNonce is true only for the first presentation', async () => {
  __resetNonceStore();
  assert.equal(await consumeNonce('n1', 5000), true);
  assert.equal(await consumeNonce('n1', 5000), false);
});

test('getNonceStoreStatus reports memory when running the per-instance fallback', async () => {
  __resetNonceStore();
  assert.equal(await getNonceStoreStatus(), 'memory');
});

test('getNonceStoreStatus reflects a shared backend\'s ping() result', async (t) => {
  t.after(() => __resetNonceStore());
  const consume = async () => true;

  setNonceStore({ consume, ping: async () => true });
  assert.equal(await getNonceStoreStatus(), 'up');

  setNonceStore({ consume, ping: async () => false });
  assert.equal(await getNonceStoreStatus(), 'down');
});

test('UpstashNonceStore.ping() reports true on a PONG reply', async (t) => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => [{ result: 'PONG' }],
  }));
  t.after(() => fetchMock.mock.restore());

  assert.equal(await new UpstashNonceStore('https://example.upstash.io', 'tok').ping(), true);
});

test('UpstashNonceStore.ping() reports false when fetch throws (network error)', async (t) => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  t.after(() => fetchMock.mock.restore());

  assert.equal(await new UpstashNonceStore('https://example.upstash.io', 'tok').ping(), false);
});
