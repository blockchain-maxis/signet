import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALHOST_APP_URL,
  appUrl,
  assertPublicEnv,
  checkPublicEnv,
  normalizeAppUrl,
  publicEnvWarnings,
  readPublicEnv,
} from './public-env.ts';

const SITE = 'https://signet.example';

test('normalizeAppUrl accepts an absolute http(s) URL and drops the trailing slash', () => {
  assert.equal(normalizeAppUrl(SITE), SITE);
  assert.equal(normalizeAppUrl(`${SITE}/`), SITE);
  assert.equal(normalizeAppUrl(`  ${SITE}//  `), SITE);
  assert.equal(normalizeAppUrl('http://localhost:3000'), 'http://localhost:3000');
  // A site served under a base path keeps it — only the trailing slash goes.
  assert.equal(normalizeAppUrl('https://example.test/signet/'), 'https://example.test/signet');
});

test('normalizeAppUrl rejects anything unusable as a base URL', () => {
  for (const value of [
    undefined,
    '',
    '   ',
    'signet.example', // no scheme — `${BASE}/p/x` would be a relative path
    '/just/a/path',
    'ftp://signet.example',
    'javascript:alert(1)',
    'https://signet.example?utm=1',
    'https://signet.example#top',
  ]) {
    assert.equal(normalizeAppUrl(value), null, String(value));
  }
});

test('production without NEXT_PUBLIC_APP_URL is refused, and the message says why', () => {
  const msg = checkPublicEnv({ NODE_ENV: 'production' });
  assert.ok(msg, 'expected a failure message');
  assert.match(msg!, /NEXT_PUBLIC_APP_URL/);
  // The point of the guard is that the breakage is otherwise silent, so the
  // message has to name what would have shipped.
  assert.match(msg!, /sitemap/);
  assert.match(msg!, /robots\.txt/);
  assert.match(msg!, new RegExp(LOCALHOST_APP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('development without NEXT_PUBLIC_APP_URL is fine — the localhost default is for this', () => {
  assert.equal(checkPublicEnv({ NODE_ENV: 'development' }), null);
  assert.equal(checkPublicEnv({}), null);
});

test('a malformed value is refused in every environment, not just production', () => {
  for (const NODE_ENV of ['production', 'development', 'test']) {
    const msg = checkPublicEnv({ NODE_ENV, NEXT_PUBLIC_APP_URL: 'signet.example' });
    assert.ok(msg, NODE_ENV);
    assert.match(msg!, /absolute http\(s\) URL/);
  }
});

test('a configured production origin passes', () => {
  assert.equal(checkPublicEnv({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: SITE }), null);
  assert.equal(checkPublicEnv({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: `${SITE}/` }), null);
});

test('a loopback production origin warns but does not block startup', () => {
  // The e2e suite boots `next start` (NODE_ENV=production) against localhost;
  // refusing that would make the guard untestable end to end.
  const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://localhost:3100' };
  assert.equal(checkPublicEnv(env), null);
  const warnings = publicEnvWarnings(env);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /loopback/);
});

test('no warning for a real production origin, or for development localhost', () => {
  assert.deepEqual(publicEnvWarnings({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: SITE }), []);
  assert.deepEqual(
    publicEnvWarnings({ NODE_ENV: 'development', NEXT_PUBLIC_APP_URL: LOCALHOST_APP_URL }),
    [],
  );
});

test('assertPublicEnv throws on a bad environment and is quiet on a good one', () => {
  assert.throws(() => assertPublicEnv({ NODE_ENV: 'production' }), /NEXT_PUBLIC_APP_URL/);
  assert.doesNotThrow(() => assertPublicEnv({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: SITE }));
});

test('appUrl returns the configured origin, normalized, and the dev default otherwise', () => {
  const original = process.env.NEXT_PUBLIC_APP_URL;
  try {
    process.env.NEXT_PUBLIC_APP_URL = `${SITE}/`;
    assert.equal(appUrl(), SITE);
    assert.equal(readPublicEnv().NEXT_PUBLIC_APP_URL, `${SITE}/`);

    delete process.env.NEXT_PUBLIC_APP_URL;
    assert.equal(appUrl(), LOCALHOST_APP_URL);

    // A value that cannot be a base URL must not be handed to `new URL()` in
    // `metadataBase`, which would throw and take the whole layout down.
    process.env.NEXT_PUBLIC_APP_URL = 'not a url';
    assert.equal(appUrl(), LOCALHOST_APP_URL);
    assert.doesNotThrow(() => new URL(appUrl()));
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = original;
  }
});
