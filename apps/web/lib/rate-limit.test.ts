import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, __resetRateLimit, getRateLimitStoreStatus, setRateLimitStore } from './rate-limit.ts';

test('allows up to the max then blocks within the window', async () => {
  __resetRateLimit();
  const key = 'ip:test';
  for (let i = 0; i < 5; i++) {
    assert.equal((await rateLimit(key, 5)).ok, true, `call ${i + 1} should pass`);
  }
  assert.equal((await rateLimit(key, 5)).ok, false, '6th call should be blocked');
});

test('decrements remaining', async () => {
  __resetRateLimit();
  assert.equal((await rateLimit('k', 3)).remaining, 2);
  assert.equal((await rateLimit('k', 3)).remaining, 1);
  assert.equal((await rateLimit('k', 3)).remaining, 0);
});

test('separate keys have independent budgets', async () => {
  __resetRateLimit();
  await rateLimit('a', 1);
  assert.equal((await rateLimit('a', 1)).ok, false);
  assert.equal((await rateLimit('b', 1)).ok, true);
});

test('window resets after expiry', async () => {
  __resetRateLimit();
  assert.equal((await rateLimit('w', 1, 1)).ok, true); // 1ms window
  const past = Date.now() + 5;
  while (Date.now() < past) {
    /* spin briefly past the 1ms window */
  }
  assert.equal((await rateLimit('w', 1, 1)).ok, true);
});

test('getRateLimitStoreStatus reports memory when running the per-instance fallback', async () => {
  __resetRateLimit();
  assert.equal(await getRateLimitStoreStatus(), 'memory');
});

test('getRateLimitStoreStatus reflects a shared backend\'s ping() result', async (t) => {
  t.after(() => __resetRateLimit());
  const hit = async () => ({ ok: true, remaining: 0, resetMs: 0 });

  setRateLimitStore({ hit, ping: async () => true });
  assert.equal(await getRateLimitStoreStatus(), 'up');

  setRateLimitStore({ hit, ping: async () => false });
  assert.equal(await getRateLimitStoreStatus(), 'down');
});
