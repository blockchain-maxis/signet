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

test('withV1() computes weak ETag and same body gives the same ETag', async () => {
  const handler = withV1(async () => ok({ user: 'alice', score: 100 }));
  const req1 = new Request('http://localhost/api/v1/test', {
    headers: { 'x-forwarded-for': '127.0.0.1' },
  });
  const res1 = await handler(req1);

  assert.equal(res1.status, 200);
  const etag1 = res1.headers.get('ETag');
  assert.ok(etag1, 'Response must have an ETag header');
  assert.ok(etag1.startsWith('W/'), 'ETag must be weak by default');

  const req2 = new Request('http://localhost/api/v1/test', {
    headers: { 'x-forwarded-for': '127.0.0.2' },
  });
  const res2 = await handler(req2);
  const etag2 = res2.headers.get('ETag');
  assert.equal(etag1, etag2, 'Same body must yield identical ETag');

  // Different body produces different ETag
  const diffHandler = withV1(async () => ok({ user: 'bob', score: 200 }));
  const diffRes = await diffHandler(req1);
  assert.notEqual(diffRes.headers.get('ETag'), etag1);
});

test('withV1() answers matching If-None-Match with 304 and no body, preserving headers', async () => {
  const handler = withV1(async () => ok({ user: 'alice' }), {
    cache: 'public, max-age=60',
  });

  const initialReq = new Request('http://localhost/api/v1/user');
  const initialRes = await handler(initialReq);
  const etag = initialRes.headers.get('ETag')!;
  assert.ok(etag);

  const conditionalReq = new Request('http://localhost/api/v1/user', {
    headers: { 'If-None-Match': etag },
  });
  const res304 = await handler(conditionalReq);

  assert.equal(res304.status, 304);
  assert.equal(res304.headers.get('ETag'), etag);
  assert.equal(res304.headers.get('Cache-Control'), 'public, max-age=60');
  assert.equal(res304.headers.get('Access-Control-Allow-Origin'), '*');
  assert.ok(res304.headers.has('RateLimit-Limit'));
  assert.ok(res304.headers.has('RateLimit-Remaining'));
  assert.ok(res304.headers.has('RateLimit-Reset'));

  const body = await res304.text();
  assert.equal(body, '', '304 response must have no body');
});

test('withV1() performs weak ETag comparison for If-None-Match', async () => {
  const handler = withV1(async () => ok({ items: [1, 2] }));
  const initialRes = await handler(new Request('http://localhost/api/v1/items'));
  const weakEtag = initialRes.headers.get('ETag')!; // e.g. W/"<hash>"
  const rawTag = weakEtag.replace(/^W\//, ''); // e.g. "<hash>"

  // Weak comparison: client sends tag without W/
  const reqWithoutW = new Request('http://localhost/api/v1/items', {
    headers: { 'If-None-Match': rawTag },
  });
  const res1 = await handler(reqWithoutW);
  assert.equal(res1.status, 304);

  // Weak comparison: client sends comma-separated list
  const reqList = new Request('http://localhost/api/v1/items', {
    headers: { 'If-None-Match': `"other", ${weakEtag}` },
  });
  const res2 = await handler(reqList);
  assert.equal(res2.status, 304);

  // Client sends wildcard *
  const reqWildcard = new Request('http://localhost/api/v1/items', {
    headers: { 'If-None-Match': '*' },
  });
  const res3 = await handler(reqWildcard);
  assert.equal(res3.status, 304);

  // Client sends non-matching tag -> 200 with full body
  const reqMismatch = new Request('http://localhost/api/v1/items', {
    headers: { 'If-None-Match': '"stale-tag"' },
  });
  const resMismatch = await handler(reqMismatch);
  assert.equal(resMismatch.status, 200);
  const data = await resMismatch.json();
  assert.deepEqual(data.data, { items: [1, 2] });
});

test('withV1() preserves handler-supplied strong ETag', async () => {
  const strongEtag = '"strong-hash-custom-42"';
  const handler = withV1(async () => {
    return new Response(JSON.stringify({ custom: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ETag: strongEtag,
      },
    });
  });

  const res = await handler(new Request('http://localhost/api/v1/custom'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ETag'), strongEtag);

  // Conditional request with strong ETag
  const req304 = new Request('http://localhost/api/v1/custom', {
    headers: { 'If-None-Match': strongEtag },
  });
  const res304 = await handler(req304);
  assert.equal(res304.status, 304);
  assert.equal(res304.headers.get('ETag'), strongEtag);
});

test('withV1() skips ETags on no-store responses (such as health)', async () => {
  const healthHandler = withV1(async () => ok({ status: 'pass', apiVersion: '1' }), {
    cache: 'no-store',
  });

  const res = await healthHandler(new Request('http://localhost/api/v1/health'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.has('ETag'), false, 'no-store response must not have ETag');

  // If-None-Match against no-store response still returns 200
  const reqWithEtag = new Request('http://localhost/api/v1/health', {
    headers: { 'If-None-Match': '"some-etag"' },
  });
  const resWithMatch = await healthHandler(reqWithEtag);
  assert.equal(resWithMatch.status, 200);
  assert.equal(resWithMatch.headers.has('ETag'), false);
});

test('withV1() sets Access-Control-Expose-Headers with all required headers', async () => {
  const handler = withV1(async () => ok({ key: 'val' }));
  const res = await handler(new Request('http://localhost/api/v1/test'));

  const exposed = res.headers.get('Access-Control-Expose-Headers');
  assert.ok(exposed);

  const expectedHeaders = [
    'ETag',
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
    'Retry-After',
    'Deprecation',
    'Sunset',
  ];

  for (const h of expectedHeaders) {
    assert.ok(exposed.includes(h), `Access-Control-Expose-Headers must include ${h}`);
  }
});
