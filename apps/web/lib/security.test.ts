import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNKNOWN_IP, clientIp, isSameOrigin } from './security.ts';

function req(headers: Record<string, string>): Request {
  return { headers: new Headers(headers) } as unknown as Request;
}

test('allows a same-origin request (matches app url)', () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
  assert.ok(isSameOrigin(req({ origin: 'https://app.test' })));
});

test('allows a same-origin request via the host header', () => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  assert.ok(isSameOrigin(req({ host: 'app.test', origin: 'https://app.test' })));
});

test('rejects a cross-origin request', () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
  assert.equal(isSameOrigin(req({ origin: 'https://evil.test' })), false);
});

test('rejects when no origin or referer is present', () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
  assert.equal(isSameOrigin(req({})), false);
});

test('falls back to the referer header', () => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';
  assert.ok(isSameOrigin(req({ referer: 'https://app.test/app' })));
});

// ── clientIp ──────────────────────────────────────────────────────────────
// The rate limiter keys on this. Reading a client-controlled value here means
// rotating one header buys an unlimited quota, which is exactly what the
// previous implementation (leftmost X-Forwarded-For entry) allowed.

test('clientIp uses the platform header the edge overwrites', () => {
  assert.equal(
    clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4', 'x-vercel-forwarded-for': '203.0.113.9' })),
    '203.0.113.9',
  );
  assert.equal(
    clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4', 'x-nf-client-connection-ip': '203.0.113.7' })),
    '203.0.113.7',
  );
});

test('spoofing X-Forwarded-For cannot change the bucket behind a platform edge', () => {
  const bucketFor = (spoof: string) =>
    clientIp(new Headers({ 'x-forwarded-for': spoof, 'x-vercel-forwarded-for': '203.0.113.9' }));
  assert.equal(bucketFor('198.51.100.1'), bucketFor('198.51.100.2'));
});

test('X-Forwarded-For is ignored entirely when no proxy hops are configured', () => {
  // The bypass this closes: without a declared proxy, every entry in the chain
  // is client-chosen, so believing any of them hands out unlimited quota.
  delete process.env.SIGNET_TRUSTED_PROXY_HOPS;
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '198.51.100.1' })), UNKNOWN_IP);
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 198.51.100.5' })), UNKNOWN_IP);
  assert.equal(clientIp(new Headers({ 'x-real-ip': '198.51.100.9' })), UNKNOWN_IP);
});

test('rotating X-Forwarded-For yields one shared bucket, not one per value', () => {
  delete process.env.SIGNET_TRUSTED_PROXY_HOPS;
  const buckets = new Set(
    Array.from({ length: 20 }, (_, i) => clientIp(new Headers({ 'x-forwarded-for': `198.51.100.${i}` }))),
  );
  assert.equal(buckets.size, 1, 'a rotating header must not mint a fresh bucket per request');
});

test('with one declared proxy hop, the appended entry is used, not the client-supplied one', () => {
  process.env.SIGNET_TRUSTED_PROXY_HOPS = '1';
  try {
    // Client claims 9.9.9.9; the proxy appends the real peer 198.51.100.5.
    assert.equal(clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 198.51.100.5' })), '198.51.100.5');
    assert.equal(clientIp(new Headers({ 'x-real-ip': '198.51.100.9' })), '198.51.100.9');
  } finally {
    delete process.env.SIGNET_TRUSTED_PROXY_HOPS;
  }
});

test('with two declared proxy hops, the outermost proxy\'s view is used', () => {
  process.env.SIGNET_TRUSTED_PROXY_HOPS = '2';
  try {
    assert.equal(
      clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9, 198.51.100.5, 10.0.0.1' })),
      '198.51.100.5',
    );
  } finally {
    delete process.env.SIGNET_TRUSTED_PROXY_HOPS;
  }
});

test('clientIp falls back to a single shared bucket when nothing is trustworthy', () => {
  assert.equal(clientIp(new Headers()), UNKNOWN_IP);
  assert.equal(clientIp(new Headers({ 'x-forwarded-for': '  ' })), UNKNOWN_IP);
});
