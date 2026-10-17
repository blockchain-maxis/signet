import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ok,
  fail,
  withV1,
  V1Error,
  parseHandle,
  parseAddress,
  parseLimit,
  encodeCursor,
  parseCursor,
  HTTP_STATUS_BY_CODE,
  type V1ErrorCode,
} from './http.ts';
import { __resetRateLimit } from '../../rate-limit.ts';

test('ok() creates standard success envelope', async () => {
  const res = ok({ id: 123 }, { nextCursor: 'abc' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');

  const body = await res.json();
  assert.deepEqual(body, {
    data: { id: 123 },
    meta: { nextCursor: 'abc' },
  });
});

test('ok() omits meta when omitted', async () => {
  const res = ok(['item1', 'item2']);
  const body = await res.json();
  assert.deepEqual(body, {
    data: ['item1', 'item2'],
  });
  assert.equal('meta' in body, false);
});

test('fail() creates standard error envelope with status mapping', async () => {
  const codes: V1ErrorCode[] = [
    'bad_request',
    'unauthorized',
    'not_found',
    'rate_limited',
    'unavailable',
    'internal',
  ];

  for (const code of codes) {
    const expectedStatus = HTTP_STATUS_BY_CODE[code];
    const res = fail(code, `Message for ${code}`, { param: 'test' });
    assert.equal(res.status, expectedStatus, `status for code ${code}`);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');

    const body = await res.json();
    assert.deepEqual(body, {
      error: {
        code,
        message: `Message for ${code}`,
        details: { param: 'test' },
      },
    });
  }
});

test('fail() omits details when not provided', async () => {
  const res = fail('not_found', 'Resource not found');
  const body = await res.json();
  assert.deepEqual(body, {
    error: {
      code: 'not_found',
      message: 'Resource not found',
    },
  });
  assert.equal('details' in body.error, false);
});

test('withV1() handles OPTIONS preflight', async () => {
  const handler = withV1(async () => ok({ hello: 'world' }));
  const req = new Request('http://localhost/api/v1/test', {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com' },
  });

  const res = await handler(req);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  assert.equal(res.headers.get('Access-Control-Max-Age'), '86400');
});

test('withV1() rejects mutating methods with 405 Method Not Allowed and Allow header', async () => {
  const handler = withV1(async () => ok({ hello: 'world' }));
  const mutatingMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];

  for (const method of mutatingMethods) {
    const req = new Request('http://localhost/api/v1/test', { method });
    const res = await handler(req);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('Allow'), 'GET, HEAD, OPTIONS');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');

    const body = await res.json();
    assert.equal(body.error?.code, 'bad_request');
  }
});

test('withV1() applies CORS, RateLimit headers, and cache headers on success', async () => {
  __resetRateLimit();
  const handler = withV1(async () => ok({ items: [1, 2, 3] }), {
    cache: 'public, max-age=30, stale-while-revalidate=60',
  });

  const req = new Request('http://localhost/api/v1/items', {
    method: 'GET',
    headers: { 'x-forwarded-for': '198.51.100.1' },
  });

  const res = await handler(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=30, stale-while-revalidate=60');
  assert.ok(res.headers.has('RateLimit-Limit'));
  assert.ok(res.headers.has('RateLimit-Remaining'));
  assert.ok(res.headers.has('RateLimit-Reset'));

  const body = await res.json();
  assert.deepEqual(body.data, { items: [1, 2, 3] });
});

test('withV1() returns 429 with Retry-After and RateLimit headers when over budget', async () => {
  __resetRateLimit();
  const handler = withV1(async () => ok({ ok: true }), { bucket: 'v1Read' });
  const ip = '198.51.100.42';

  // Consume all 60 calls
  for (let i = 0; i < 60; i++) {
    const req = new Request('http://localhost/api/v1/test', {
      headers: { 'x-vercel-forwarded-for': ip },
    });
    const res = await handler(req);
    assert.equal(res.status, 200);
  }

  // 61st call should trigger 429
  const overReq = new Request('http://localhost/api/v1/test', {
    headers: { 'x-vercel-forwarded-for': ip },
  });
  const overRes = await handler(overReq);
  assert.equal(overRes.status, 429);
  assert.ok(overRes.headers.has('Retry-After'));
  assert.equal(overRes.headers.get('RateLimit-Remaining'), '0');
  assert.ok(overRes.headers.has('RateLimit-Reset'));
  assert.equal(overRes.headers.get('Access-Control-Allow-Origin'), '*');

  const body = await overRes.json();
  assert.equal(body.error?.code, 'rate_limited');
  assert.ok(body.error?.details?.retryAfter > 0);
});

test('withV1() safely maps uncaught errors to sanitized internal 500 with no stack', async () => {
  const handler = withV1(async () => {
    throw new Error('database connection password=secret leaked table sensitive');
  });

  const req = new Request('http://localhost/api/v1/leak-test');
  const res = await handler(req);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');

  const body = await res.json();
  assert.deepEqual(body, {
    error: {
      code: 'internal',
      message: 'Something went wrong. Try again later.',
    },
  });
  assert.equal('stack' in body.error, false);
});

test('withV1() handles thrown V1Error correctly', async () => {
  const handler = withV1(async () => {
    throw new V1Error('not_found', 'Handle not registered', { handle: 'unknown' });
  });

  const req = new Request('http://localhost/api/v1/error-test');
  const res = await handler(req);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');

  const body = await res.json();
  assert.deepEqual(body, {
    error: {
      code: 'not_found',
      message: 'Handle not registered',
      details: { handle: 'unknown' },
    },
  });
});

test('parseHandle() normalizes and validates handles', () => {
  assert.equal(parseHandle('alice'), 'alice');
  assert.equal(parseHandle('  ALICE  '), 'alice');
  assert.equal(parseHandle('bob_1-dev'), 'bob_1-dev');

  assert.throws(() => parseHandle(''), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseHandle('invalid handle with space'), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseHandle('emoji✨'), {
    name: 'V1Error',
    code: 'bad_request',
  });
});

test('parseAddress() validates Stellar account and contract addresses', () => {
  const validG = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const validC = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM66';

  assert.equal(parseAddress(validG), validG);
  assert.equal(parseAddress(validC), validC);
  assert.equal(parseAddress(validG, 'G'), validG);
  assert.equal(parseAddress(validC, 'C'), validC);

  // Wrong kind
  assert.throws(() => parseAddress(validC, 'G'), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseAddress(validG, 'C'), {
    name: 'V1Error',
    code: 'bad_request',
  });

  // Malformed
  assert.throws(() => parseAddress('short'), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseAddress('XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'), {
    name: 'V1Error',
    code: 'bad_request',
  });
});

test('parseLimit() enforces bounds and defaults', () => {
  assert.equal(parseLimit(undefined), 25);
  assert.equal(parseLimit(null), 25);
  assert.equal(parseLimit(''), 25);
  assert.equal(parseLimit(10), 10);
  assert.equal(parseLimit('50'), 50);
  assert.equal(parseLimit('100'), 100);

  assert.throws(() => parseLimit(0), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseLimit(-5), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseLimit(101), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseLimit('abc'), {
    name: 'V1Error',
    code: 'bad_request',
  });
  assert.throws(() => parseLimit(12.5), {
    name: 'V1Error',
    code: 'bad_request',
  });
});

test('encodeCursor() and parseCursor() round-trip opaque pagination cursors', () => {
  const payload = { timestamp: 1729000000, id: 'item_123' };
  const encoded = encodeCursor(payload);

  assert.equal(typeof encoded, 'string');
  assert.ok(!encoded.includes('{'), 'cursor must be opaque');

  const decoded = parseCursor<{ timestamp: number; id: string }>(encoded);
  assert.deepEqual(decoded, payload);

  // Empty returns null
  assert.equal(parseCursor(null), null);
  assert.equal(parseCursor(undefined), null);
  assert.equal(parseCursor(''), null);

  // Tampered or invalid cursor throws bad_request
  assert.throws(() => parseCursor('not-valid-base64url!#$'), {
    name: 'V1Error',
    code: 'bad_request',
  });
  // Unsupported version byte
  const badVersionCursor = encodeCursor(payload, 2);
  assert.throws(() => parseCursor(badVersionCursor, 1), {
    name: 'V1Error',
    code: 'bad_request',
  });
});
