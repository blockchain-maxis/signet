import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, enforceRateLimit } from './rate-limit-http.ts';
import { __resetRateLimit } from './rate-limit.ts';

test('LIMITS contains cli:pair:start and cli:pair:complete buckets with limits comparable to sep10', () => {
  assert.equal(LIMITS['cli:pair:start'], 12);
  assert.equal(LIMITS['cli:pair:complete'], 12);
  assert.equal(LIMITS['cli:pair:start'], LIMITS.sep10);
  assert.equal(LIMITS['cli:pair:complete'], LIMITS.sep10);
});

test('enforceRateLimit enforces cli:pair:start limit and returns 429 when budget exceeded', async () => {
  __resetRateLimit();
  const bucket = 'cli:pair:start';
  const limit = LIMITS['cli:pair:start'];
  const req = new Request('http://localhost/api/cli/pair/start', {
    headers: { 'x-forwarded-for': '192.0.2.1' },
  });

  for (let i = 0; i < limit; i++) {
    const limited = await enforceRateLimit(req, bucket, limit);
    assert.equal(limited, null, `request ${i + 1} should be permitted`);
  }

  const blocked = await enforceRateLimit(req, bucket, limit);
  assert.notEqual(blocked, null);
  assert.equal(blocked?.status, 429);
  assert.equal(blocked?.headers.get('retry-after'), '60');
  assert.equal(blocked?.headers.get('cache-control'), 'no-store');

  const body = (await blocked?.json()) as { error?: string };
  assert.equal(body.error, 'Too many requests');
});

test('enforceRateLimit enforces cli:pair:complete limit and returns 429 when budget exceeded', async () => {
  __resetRateLimit();
  const bucket = 'cli:pair:complete';
  const limit = LIMITS['cli:pair:complete'];
  const req = new Request('http://localhost/api/cli/pair/complete', {
    headers: { 'x-forwarded-for': '192.0.2.2' },
  });

  for (let i = 0; i < limit; i++) {
    const limited = await enforceRateLimit(req, bucket, limit);
    assert.equal(limited, null, `request ${i + 1} should be permitted`);
  }

  const blocked = await enforceRateLimit(req, bucket, limit);
  assert.notEqual(blocked, null);
  assert.equal(blocked?.status, 429);
  assert.equal(blocked?.headers.get('retry-after'), '60');
  assert.equal(blocked?.headers.get('cache-control'), 'no-store');

  const body = (await blocked?.json()) as { error?: string };
  assert.equal(body.error, 'Too many requests');
});
