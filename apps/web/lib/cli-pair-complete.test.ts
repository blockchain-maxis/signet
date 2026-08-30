import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GET, POST } from '../app/api/cli/pair/complete/route.ts';

const original = process.env.DATABASE_URL;

afterEach(() => {
  if (original === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original;
});

test('POST fails closed with 503 when no database is configured', async () => {
  delete process.env.DATABASE_URL;

  const res = await POST();
  assert.equal(res.status, 503);

  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.error, 'database_required');
  // 503 and this flag together are what let the CLI report a deployment
  // problem rather than blaming the user's wallet or signature.
  assert.equal(body.isConfigurationError, true);
  assert.match(String(body.message), /requires a database/);
  assert.match(String(body.docs), /docs\/CLI\.md/);
  // Nothing changes until an operator acts, so nothing should be cached.
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('the refusal is not a 4xx — nothing the caller sent is wrong', async () => {
  delete process.env.DATABASE_URL;
  const res = await POST();
  assert.ok(res.status >= 500, `expected a server-side status, got ${res.status}`);
});

test('POST gets past the precondition once a database is configured', async () => {
  process.env.DATABASE_URL = 'postgres://localhost:5432/signet';

  const res = await POST();
  // 501, not 200: pairing verification is #268's, and this route will not
  // pretend to complete a pairing it has not verified.
  assert.equal(res.status, 501);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.error, 'not_implemented');
});

test('GET reports availability so /link can warn before approval', async () => {
  delete process.env.DATABASE_URL;
  let body = (await GET().json()) as Record<string, unknown>;
  assert.equal(body.available, false);
  assert.equal(body.reason, 'database_required');

  process.env.DATABASE_URL = 'postgres://localhost:5432/signet';
  body = (await GET().json()) as Record<string, unknown>;
  assert.equal(body.available, true);
  assert.equal(body.reason, undefined);
});
