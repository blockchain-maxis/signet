import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidHandle,
  getProfile,
  getOperations,
  getPagedOperations,
  listHandles,
  listAllHandles,
  safeChainHandles,
  safeChainProfile,
  decodeResolvedAddress,
  computeStats,
  getOperationsResult,
  formatCount,
} from './profiles.ts';

test('isValidHandle accepts the registry charset', () => {
  for (const h of ['aquawolf', 'dev_01', 'a-b-c', 'x'.repeat(32)]) {
    assert.ok(isValidHandle(h), `expected ${h} valid`);
  }
});

test('isValidHandle rejects malformed handles', () => {
  for (const h of ['', 'Aqua', 'has space', 'bad!', 'x'.repeat(33), 'em@il']) {
    assert.ok(!isValidHandle(h), `expected ${h} invalid`);
  }
});

test('getProfile returns curated data for a known handle', async () => {
  const p = await getProfile('aquawolf');
  assert.ok(p, 'aquawolf profile should exist');
  assert.match(p!.wallet, /^G[A-Z0-9]{55}$/, 'wallet is a Stellar account id');
  assert.ok(p!.name.length > 0);
});

test('getProfile rejects invalid handles without filesystem access', async () => {
  assert.equal(await getProfile('../../etc/passwd'), null);
});

test('curated profiles still resolve when neither a DB nor a registry is configured', async () => {
  // No DATABASE_URL and no REGISTRY_CONTRACT_ID here, so both the database and
  // chain layers no-op and resolution falls through to the static manifest.
  const p = await getProfile('aquawolf');
  assert.ok(p, 'aquawolf should resolve from the static manifest');
  assert.equal(p!.source, 'demo');
});

test('safeChainProfile is a no-op when the registry is not configured', async () => {
  // Returns without any network access — an unconfigured registry must not
  // cost a doomed RPC round trip on every profile render.
  assert.equal(await safeChainProfile('aquawolf'), null);
});

test('safeChainProfile rejects invalid handles before any network access', async () => {
  assert.equal(await safeChainProfile('../../etc/passwd'), null);
});

test('decodeResolvedAddress accepts account and contract addresses', () => {
  const account = `G${'A'.repeat(55)}`;
  const contract = `C${'A'.repeat(55)}`;
  assert.equal(decodeResolvedAddress(account), account);
  assert.equal(decodeResolvedAddress(contract), contract);
});

test('decodeResolvedAddress rejects an unbound handle and malformed values', () => {
  // `resolve` returns Option<Address>; `None` decodes to null.
  assert.equal(decodeResolvedAddress(null), null);
  assert.equal(decodeResolvedAddress(undefined), null);
  assert.equal(decodeResolvedAddress(''), null);
  assert.equal(decodeResolvedAddress(`G${'A'.repeat(54)}`), null);
  assert.equal(decodeResolvedAddress(`X${'A'.repeat(55)}`), null);
  assert.equal(decodeResolvedAddress({ wallet: `G${'A'.repeat(55)}` }), null);
});

test('listHandles includes the curated profiles', async () => {
  const handles = await listHandles();
  assert.ok(handles.includes('aquawolf'));
  assert.ok(handles.length >= 3);
});

test('listAllHandles is a deduped superset of the curated handles', async () => {
  // With neither DATABASE_URL nor a registry configured, the database and chain
  // sources are both empty, so this is the curated set — but always deduped and
  // never fewer than the manifest.
  const [all, curated] = await Promise.all([listAllHandles(), listHandles()]);
  for (const handle of curated) assert.ok(all.includes(handle));
  assert.equal(all.length, new Set(all).size);
});

test('safeChainHandles is a no-op when the registry is not configured', async () => {
  // Must not cost an RPC round trip on every sitemap build.
  assert.deepEqual(await safeChainHandles(), []);
});

test('computeStats returns zeroed stats for missing or empty operations', () => {
  assert.deepEqual(computeStats(undefined), { invocations: 0, uniqueFunctions: 0, reputation: 0 });
  assert.deepEqual(computeStats([]), { invocations: 0, uniqueFunctions: 0, reputation: 0 });
});

test('getOperations returns an array (possibly empty) for any handle', async () => {
  assert.ok(Array.isArray(await getOperations('aquawolf')));
  assert.deepEqual(await getOperations('does-not-exist'), []);
});

test('formatCount only claims a total when the record is complete', () => {
  assert.equal(formatCount(412, false), '412');
  // A capped read supports "at least 412", never "412".
  assert.equal(formatCount(412, true), '412+');
  assert.equal(formatCount(0, true), '0+');
});

test('getOperationsResult reports curated demo history as complete', async () => {
  const result = await getOperationsResult('aquawolf');
  assert.ok(Array.isArray(result.operations));
  assert.equal(result.truncated, false);
  assert.equal(result.cap, null);
  assert.equal(result.source, result.operations.length > 0 ? 'demo' : 'none');
});

test('getOperationsResult is empty and complete for an unknown handle', async () => {
  assert.deepEqual(await getOperationsResult('does-not-exist'), {
    operations: [],
    source: 'none',
    truncated: false,
    cap: null,
  });
});

test('getOperations still returns a bare array of operations', async () => {
  const [bare, result] = await Promise.all([
    getOperations('aquawolf'),
    getOperationsResult('aquawolf'),
  ]);
  assert.deepEqual(bare, result.operations);
});

test('getPagedOperations is a no-op without a DATABASE_URL', async () => {
  // No DATABASE_URL configured in this test environment, so the DB layer
  // must no-op rather than throwing, letting the route fall back cleanly.
  assert.equal(await getPagedOperations('aquawolf', 0, 25), null);
});

test('getPagedOperations rejects invalid handles without a DB round trip', async () => {
  assert.equal(await getPagedOperations('../../etc/passwd', 0, 25), null);
});
