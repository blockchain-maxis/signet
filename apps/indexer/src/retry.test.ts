import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientError, calculateBackoff, withRetry } from './retry.ts';

// ─── isTransientError ────────────────────────────────────────────────────────

test('isTransientError detects 429 Too Many Requests', () => {
  assert.equal(isTransientError(new Error('Horizon returned status 429')), true);
  assert.equal(isTransientError(new Error('status: 429, retry after 30s')), true);
  assert.equal(isTransientError(new Error('rate limit: 429')), true);
});

test('isTransientError detects 5xx server errors', () => {
  assert.equal(isTransientError(new Error('status 500 Internal Server Error')), true);
  assert.equal(isTransientError(new Error('502 Bad Gateway')), true);
  assert.equal(isTransientError(new Error('503 Service Unavailable')), true);
  assert.equal(isTransientError(new Error('status: 504, gateway timeout')), true);
});

test('isTransientError detects network-level errors', () => {
  assert.equal(isTransientError(new Error('fetch failed')), true);
  assert.equal(isTransientError(new Error('request failed: connect ECONNREFUSED')), true);
  assert.equal(isTransientError(new Error('connect ETIMEDOUT')), true);
  assert.equal(isTransientError(new Error('socket hang up')), true);
  assert.equal(isTransientError(new Error('socket timeout')), true);
  assert.equal(isTransientError(new Error('request aborted')), true);
  assert.equal(isTransientError(new Error('timeout exceeded')), true);
  assert.equal(isTransientError(new Error('dns resolution failed')), true);
});

test('isTransientError returns false for non-transient client errors', () => {
  assert.equal(isTransientError(new Error('status 400 Bad Request')), false);
  assert.equal(isTransientError(new Error('status 403 Forbidden')), false);
  assert.equal(isTransientError(new Error('status 404 Not Found')), false);
  assert.equal(isTransientError(new Error('status 409 Conflict')), false);
  assert.equal(isTransientError(new Error('status 422 Unprocessable Entity')), false);
});

test('isTransientError returns false for arbitrary non-HTTP errors', () => {
  assert.equal(isTransientError(new Error('something went wrong')), false);
  assert.equal(isTransientError(new TypeError('invalid type')), false);
  assert.equal(isTransientError('just a string'), false);
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(undefined), false);
});

// ─── calculateBackoff ────────────────────────────────────────────────────────

test('calculateBackoff returns a value within the capped exponential range', () => {
  // Attempt 0: baseDelay=1000 → min(1000*2^0, 30000) = 1000 → [0, 1000]
  for (let i = 0; i < 100; i++) {
    const d = calculateBackoff(0, 1000, 30000);
    assert.ok(d >= 0, `expected >= 0, got ${d}`);
    assert.ok(d <= 1000, `expected <= 1000, got ${d}`);
  }
});

test('calculateBackoff increases with attempt count', () => {
  // Attempt 5: baseDelay=1000 → min(1000*2^5, 30000) = 30000 → [0, 30000]
  for (let i = 0; i < 100; i++) {
    const d = calculateBackoff(5, 1000, 30000);
    assert.ok(d >= 0, `expected >= 0, got ${d}`);
    assert.ok(d <= 30000, `expected <= 30000, got ${d}`);
  }
});

test('calculateBackoff caps at maxDelayMs', () => {
  for (let i = 0; i < 100; i++) {
    // Attempt 100 overshoots massively, but is capped at 5000
    const d = calculateBackoff(100, 1000, 5000);
    assert.ok(d >= 0, `expected >= 0, got ${d}`);
    assert.ok(d <= 5000, `expected <= 5000, got ${d}`);
  }
});

test('calculateBackoff produces varying values (jitter)', () => {
  const results = new Set<number>();
  for (let i = 0; i < 50; i++) {
    results.add(calculateBackoff(2, 1000, 10000));
  }
  // With full jitter range [0, 4000], we expect at least some variety
  assert.ok(results.size > 1, 'expected jitter to produce multiple distinct values');
});

// ─── withRetry ───────────────────────────────────────────────────────────────

test('withRetry resolves on first attempt when no error occurs', async () => {
  const result = await withRetry(() => Promise.resolve(42));
  assert.equal(result, 42);
});

test('withRetry retries on transient errors and eventually succeeds', async () => {
  let attempts = 0;

  const result = await withRetry(
    () => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(new Error('Horizon returned status 429'));
      }
      return Promise.resolve('success');
    },
    { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
  );

  assert.equal(result, 'success');
  assert.equal(attempts, 3);
});

test('withRetry throws immediately on non-transient errors', async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      () => {
        attempts++;
        return Promise.reject(new Error('status 400 Bad Request'));
      },
      { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 },
    ),
    /status 400 Bad Request/,
  );

  assert.equal(attempts, 1, 'should not retry non-transient errors');
});

test('withRetry exhausts attempts on persistent transient errors', async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      () => {
        attempts++;
        return Promise.reject(new Error('503 Service Unavailable'));
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 },
    ),
    /503 Service Unavailable/,
  );

  assert.equal(attempts, 3);
});

test('withRetry uses custom maxAttempts', async () => {
  let attempts = 0;

  await assert.rejects(
    withRetry(
      () => {
        attempts++;
        return Promise.reject(new Error('timeout exceeded'));
      },
      { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 },
    ),
  );

  assert.equal(attempts, 5);
});

test('withRetry mock fails twice then succeeds (acceptance criteria)', async () => {
  // This is the exact scenario from the issue: a mock that fails twice then succeeds
  let callCount = 0;
  const fn = async () => {
    callCount++;
    if (callCount <= 2) {
      throw new Error('status 429');
    }
    return 'all good';
  };

  const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 });

  assert.equal(result, 'all good');
  assert.equal(callCount, 3);
});
