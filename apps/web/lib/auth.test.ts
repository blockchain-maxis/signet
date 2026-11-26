import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, readSession, verifySession } from './auth.ts';
import {
  __resetRevocationStore,
  isRevoked,
  revokeAddress,
  revokeSession,
  setRevocationStore,
} from './session-revocation.ts';

test('session token round-trips to its address', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  assert.equal(await verifySession(token), 'GWALLET');
});

test('tampered or garbage session is rejected', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  const [data] = token.split('.');
  assert.equal(await verifySession(`${data}.deadbeef`), null);
  assert.equal(await verifySession('not-a-token'), null);
  assert.equal(await verifySession(undefined), null);
});

test('sessions issued before valid-after are revoked', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  assert.equal(await verifySession(token), 'GWALLET');
  process.env.SIGNET_SESSIONS_VALID_AFTER = String(Date.now() + 1000);
  try {
    assert.equal(await verifySession(token), null);
  } finally {
    delete process.env.SIGNET_SESSIONS_VALID_AFTER;
  }
});

test('every session carries a distinct session id', () => {
  const a = readSession(issueSession('GWALLET'));
  const b = readSession(issueSession('GWALLET'));
  assert.ok(a?.sid && b?.sid, 'expected session ids');
  assert.notEqual(a!.sid, b!.sid);
});

// ── Targeted revocation ───────────────────────────────────────────────────

test('revoking one address leaves every other address signed in', async () => {
  __resetRevocationStore();
  const compromised = issueSession('GCOMPROMISED');
  const bystander = issueSession('GBYSTANDER');

  await revokeAddress('GCOMPROMISED', { until: Date.now() + 60_000 });

  assert.equal(await verifySession(compromised), null);
  // The regression this guards: the only revocation lever used to be global,
  // so responding to one compromised wallet signed out every user.
  assert.equal(await verifySession(bystander), 'GBYSTANDER');
});

test('sign out other devices keeps the calling session alive', async () => {
  __resetRevocationStore();
  const here = issueSession('GWALLET');
  const elsewhere = issueSession('GWALLET');
  const sid = readSession(here)!.sid;

  await revokeAddress('GWALLET', { exceptSid: sid, until: Date.now() + 60_000 });

  assert.equal(await verifySession(here), 'GWALLET');
  assert.equal(await verifySession(elsewhere), null);
});

test('a session issued after the cut-off survives the revocation', async () => {
  __resetRevocationStore();
  const before = issueSession('GWALLET');
  await revokeAddress('GWALLET', { until: Date.now() + 60_000 });
  assert.equal(await verifySession(before), null);

  // Signing back in has to work, or address revocation would be a permanent ban.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await verifySession(issueSession('GWALLET')), 'GWALLET');
});

test('revoking one session leaves the other sessions of that address alone', async () => {
  __resetRevocationStore();
  const laptop = issueSession('GWALLET');
  const phone = issueSession('GWALLET');

  await revokeSession(readSession(laptop)!.sid!, readSession(laptop)!.exp);

  assert.equal(await verifySession(laptop), null);
  assert.equal(await verifySession(phone), 'GWALLET');
});

test('an expired revocation entry stops rejecting sessions', async () => {
  __resetRevocationStore();
  const token = issueSession('GWALLET');
  // `until` in the past: the entry is already meaningless and is pruned on the
  // next snapshot, so the list cannot grow without bound.
  await revokeAddress('GWALLET', { until: Date.now() - 1 });
  assert.equal(await verifySession(token), 'GWALLET');
});

test('a revocation list that cannot be read fails closed', async () => {
  // Opposite of the rate limiter, same as the nonce store: an unreadable
  // revocation list must not silently mean "nobody is revoked".
  const token = issueSession('GWALLET');
  setRevocationStore({
    async put() {},
    async snapshot() {
      return null;
    },
  });
  try {
    assert.equal(await verifySession(token), null);
    assert.equal(await isRevoked({ address: 'GWALLET', iat: Date.now(), exp: Date.now() + 1000 }), true);
  } finally {
    __resetRevocationStore();
  }
});

test('a session predating session ids is covered by an address revocation', async () => {
  __resetRevocationStore();
  const legacy = { address: 'GWALLET', iat: Date.now() - 1000, exp: Date.now() + 60_000 };
  assert.equal(await isRevoked(legacy), false);
  await revokeAddress('GWALLET', { until: Date.now() + 60_000 });
  assert.equal(await isRevoked(legacy), true);
});
