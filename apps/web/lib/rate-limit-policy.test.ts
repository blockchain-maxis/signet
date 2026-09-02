import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, rateLimitDecision } from './rate-limit-policy.ts';
import { __resetRateLimit } from './rate-limit.ts';

/** A request from `ip`, attributed via the platform header `clientIp` trusts. */
function headersFrom(ip: string): Headers {
  return new Headers({ 'x-vercel-forwarded-for': ip });
}

test('the pairing buckets exist and are held to the sep10 budget', () => {
  // Issue #270: both pairing endpoints have sep10's shape — unauthenticated at
  // the start step, an ed25519 verification at the complete step — so they get
  // sep10's budget rather than a looser one.
  assert.equal(LIMITS.cliPairStart, LIMITS.sep10);
  assert.equal(LIMITS.cliPairComplete, LIMITS.sep10);
});

test('cli:pair:start is refused once its budget is spent', async () => {
  __resetRateLimit();
  const headers = headersFrom('192.0.2.1');
  const max = LIMITS.cliPairStart;

  for (let i = 0; i < max; i++) {
    assert.equal(
      await rateLimitDecision(headers, 'cli:pair:start', max),
      null,
      `request ${i + 1} of ${max} should be permitted`,
    );
  }

  const refused = await rateLimitDecision(headers, 'cli:pair:start', max);
  assert.ok(refused, 'the request past the budget should be refused');
  assert.ok(refused.retryAfter >= 1, 'retry-after must be a usable number of seconds');
});

test('cli:pair:complete is refused once its budget is spent', async () => {
  __resetRateLimit();
  const headers = headersFrom('192.0.2.2');
  const max = LIMITS.cliPairComplete;

  for (let i = 0; i < max; i++) {
    assert.equal(await rateLimitDecision(headers, 'cli:pair:complete', max), null);
  }

  assert.ok(await rateLimitDecision(headers, 'cli:pair:complete', max));
});

test('the two pairing buckets are independent, and so are two callers', async () => {
  __resetRateLimit();
  const headers = headersFrom('192.0.2.3');
  const max = LIMITS.cliPairStart;

  for (let i = 0; i < max; i++) {
    await rateLimitDecision(headers, 'cli:pair:start', max);
  }
  assert.ok(await rateLimitDecision(headers, 'cli:pair:start', max), 'start should be spent');

  // Flooding one endpoint must not exhaust the other's budget...
  assert.equal(
    await rateLimitDecision(headers, 'cli:pair:complete', LIMITS.cliPairComplete),
    null,
    'complete has its own bucket',
  );

  // ...nor another caller's.
  assert.equal(
    await rateLimitDecision(headersFrom('192.0.2.4'), 'cli:pair:start', max),
    null,
    'a different IP has its own bucket',
  );
});
