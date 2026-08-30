import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_METHODS,
  MAX_AGE_SECONDS,
  PNA_REQUEST_HEADER,
  PNA_RESPONSE_HEADER,
  handlePreflight,
  isAllowedOrigin,
  responseHeaders,
} from './loopback-cors.ts';

const DEPLOYMENT = 'https://signet.dev';

test('a Chrome public -> private preflight gets the PNA opt-in', () => {
  const decision = handlePreflight(
    {
      origin: DEPLOYMENT,
      'access-control-request-method': 'POST',
      [PNA_REQUEST_HEADER]: 'true',
    },
    DEPLOYMENT,
  );

  assert.equal(decision.status, 204);
  // Without this exact header Chrome refuses the request and the CLI hangs.
  assert.equal(decision.headers[PNA_RESPONSE_HEADER], 'true');
  assert.equal(decision.headers['access-control-allow-origin'], DEPLOYMENT);
  assert.equal(decision.headers['access-control-allow-methods'], ALLOWED_METHODS);
  assert.equal(decision.headers['access-control-allow-headers'], 'content-type');
  assert.equal(decision.headers['access-control-max-age'], String(MAX_AGE_SECONDS));
});

test('the PNA opt-in is sent only when the browser asked for it', () => {
  // Firefox and Safari do not implement PNA and send an ordinary preflight.
  // They must still get working CORS headers, and must not be handed a
  // private-network grant nobody requested.
  const decision = handlePreflight(
    { origin: DEPLOYMENT, 'access-control-request-method': 'POST' },
    DEPLOYMENT,
  );

  assert.equal(decision.status, 204);
  assert.equal(decision.headers['access-control-allow-origin'], DEPLOYMENT);
  assert.equal(decision.headers[PNA_RESPONSE_HEADER], undefined);
});

test('the allow-origin is the deployment, never a wildcard', () => {
  const decision = handlePreflight(
    { origin: DEPLOYMENT, [PNA_REQUEST_HEADER]: 'true' },
    DEPLOYMENT,
  );
  // A wildcard on a server about to accept a pairing completion means any tab
  // the developer has open can post to it.
  assert.notEqual(decision.headers['access-control-allow-origin'], '*');
  assert.equal(decision.headers['access-control-allow-origin'], DEPLOYMENT);
});

test('a foreign origin is refused with no CORS headers at all', () => {
  for (const origin of [
    'https://evil.test',
    'https://signet.dev.evil.test',
    'http://signet.dev',
    undefined,
  ]) {
    const decision = handlePreflight(
      { ...(origin ? { origin } : {}), [PNA_REQUEST_HEADER]: 'true' },
      DEPLOYMENT,
    );
    assert.equal(decision.status, 403);
    assert.deepEqual(decision.headers, {});
    // A visible refusal beats a silent "CORS error" the developer has to guess at.
    assert.match(decision.refusal ?? '', /refused preflight/);
  }
});

test('origin comparison is on the parsed origin, not the raw string', () => {
  assert.equal(isAllowedOrigin('https://signet.dev:443', DEPLOYMENT), true);
  assert.equal(isAllowedOrigin('https://signet.dev/', DEPLOYMENT), true);
  assert.equal(isAllowedOrigin('https://signet.dev.evil.test', DEPLOYMENT), false);
  assert.equal(isAllowedOrigin('http://signet.dev', DEPLOYMENT), false);
  assert.equal(isAllowedOrigin('not a url', DEPLOYMENT), false);
  assert.equal(isAllowedOrigin(undefined, DEPLOYMENT), false);
});

test('the preflight varies on Origin and the PNA request header', () => {
  const decision = handlePreflight({ origin: DEPLOYMENT }, DEPLOYMENT);
  // A cache must not serve one origin's answer — or a non-PNA answer — to a
  // different request.
  assert.equal(decision.headers.vary, 'Origin, Access-Control-Request-Private-Network');
});

test('the real response carries CORS headers too', () => {
  // The preflight passing does not exempt the actual response: without this
  // the browser blocks the page from reading the result, which is the silent
  // hang this issue is about.
  assert.deepEqual(responseHeaders({ origin: DEPLOYMENT }, DEPLOYMENT), {
    'access-control-allow-origin': DEPLOYMENT,
    vary: 'Origin',
  });
  assert.deepEqual(responseHeaders({ origin: 'https://evil.test' }, DEPLOYMENT), {});
});

test('header lookup tolerates array-valued headers', () => {
  const decision = handlePreflight(
    { origin: [DEPLOYMENT], [PNA_REQUEST_HEADER]: ['true'] },
    DEPLOYMENT,
  );
  assert.equal(decision.status, 204);
  assert.equal(decision.headers[PNA_RESPONSE_HEADER], 'true');
});
