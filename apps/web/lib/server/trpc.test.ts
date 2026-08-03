import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appRouter, createContext } from './trpc.ts';
import { __resetRateLimit } from '../rate-limit.ts';
import { issueSession, SESSION_COOKIE } from '../auth.ts';

// Integration test over the full API stack: input validation → rate-limit +
// logging middleware → profile data layer. Uses the synthetic testnet fixtures
// in public/data (cwd is apps/web when the test runs).
function caller(ip: string) {
  return appRouter.createCaller(createContext(new Headers({ 'x-forwarded-for': ip })));
}

/** Caller with a valid session cookie (and optional same-origin headers). */
function authedCaller(ip: string, address: string, extra: Record<string, string> = {}) {
  const headers = new Headers({
    'x-forwarded-for': ip,
    cookie: `${SESSION_COOKIE}=${issueSession(address)}`,
    ...extra,
  });
  return appRouter.createCaller(createContext(headers));
}

test('profile.byHandle returns the profile with computed on-chain stats', async () => {
  __resetRateLimit();
  const res = await caller('10.0.0.1').profile.byHandle({ handle: 'aquawolf' });
  assert.ok(res, 'expected a profile');
  assert.equal(res!.handle, 'aquawolf');
  assert.match(res!.profile.wallet, /^G[A-Z0-9]{55}$/);
  assert.ok(res!.stats.invocations >= 1);
  assert.ok(res!.stats.uniqueFunctions >= 1);
});

test('profile.byHandle rejects a malformed handle', async () => {
  __resetRateLimit();
  await assert.rejects(() => caller('10.0.0.2').profile.byHandle({ handle: 'BAD HANDLE!' }));
});

test('profile.list includes the curated handles', async () => {
  __resetRateLimit();
  const list = await caller('10.0.0.3').profile.list();
  assert.ok(list.includes('aquawolf'));
  assert.ok(list.length >= 3);
});

test('health procedure reports ok', async () => {
  __resetRateLimit();
  const res = await caller('10.0.0.4').health();
  assert.equal(res.ok, true);
});

test('account.me rejects a request with no session', async () => {
  __resetRateLimit();
  await assert.rejects(() => caller('10.0.2.1').account.me(), /Unauthorized/);
});

test('account.me returns the signed-in address', async () => {
  __resetRateLimit();
  const res = await authedCaller('10.0.2.2', 'GTESTADDRESS').account.me();
  assert.equal(res.address, 'GTESTADDRESS');
  // Neither a database nor a registry contract id is configured under test,
  // so there is nothing to resolve the handle from.
  assert.equal(res.handle, null);
  assert.equal(res.dbConfigured, false);
  assert.equal(res.editable, false);
});

test('account.update is rejected without a session', async () => {
  __resetRateLimit();
  await assert.rejects(
    () => caller('10.0.2.3').account.update({ displayName: 'x', bio: null }),
    /Unauthorized|Cross-origin/,
  );
});

test('account.update without a database surfaces a clear error', async () => {
  __resetRateLimit();
  const c = authedCaller('10.0.2.4', 'GTESTADDRESS', {
    host: 'localhost',
    origin: 'http://localhost',
  });
  await assert.rejects(() => c.account.update({ displayName: 'Ada', bio: 'hi' }), /database/i);
});

test('rate limiter blocks a caller after the window max', async () => {
  __resetRateLimit();
  const c = caller('10.0.0.99');
  let blocked = false;
  for (let i = 0; i < 65; i++) {
    try {
      await c.health();
    } catch {
      blocked = true;
      break;
    }
  }
  assert.ok(blocked, 'expected rate limiting to trigger within 65 calls');
});

test('registry.resolve rejects a malformed handle', async () => {
  __resetRateLimit();
  await assert.rejects(() => caller('10.0.0.10').registry.resolve({ handle: 'BAD HANDLE!' }));
});

test('registry.resolve returns null when the registry is unconfigured', async () => {
  __resetRateLimit();
  const res = await caller('10.0.0.11').registry.resolve({ handle: 'aquawolf' });
  assert.equal(res, null);
});

test('registry.resolve normalises the handle to lowercase', async () => {
  __resetRateLimit();
  const res = await caller('10.0.0.12').registry.resolve({ handle: 'AQUAWOLF' });
  assert.equal(res, null);
});

test('registry.lookup rejects a malformed wallet address', async () => {
  __resetRateLimit();
  await assert.rejects(
    () => caller('10.0.0.13').registry.lookup({ wallet: 'not-a-valid-address' }),
  );
});

test('registry.lookup accepts a valid G… address', async () => {
  __resetRateLimit();
  const res = await caller('10.0.0.14').registry.lookup({
    wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
  });
  assert.equal(res, null);
});

test('registry.lookup accepts a valid C… address', async () => {
  __resetRateLimit();
  const res = await caller('10.0.0.15').registry.lookup({
    wallet: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
  });
  assert.equal(res, null);
});

test('registry.count returns zero when the registry is unconfigured', async () => {
  __resetRateLimit();
  const res = await caller('10.0.0.16').registry.count();
  assert.deepEqual(res, { count: 0 });
});
