import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidHandle,
  getProfile,
  getOperations,
  listHandles,
  listAllHandles,
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

test('listHandles includes the curated profiles', async () => {
  const handles = await listHandles();
  assert.ok(handles.includes('aquawolf'));
  assert.ok(handles.length >= 3);
});

test('listAllHandles is a deduped superset of the curated handles', async () => {
  // Without DATABASE_URL the on-chain source is empty, so this is the curated
  // set — but always deduped and never fewer than the manifest.
  const [all, curated] = await Promise.all([listAllHandles(), listHandles()]);
  for (const handle of curated) assert.ok(all.includes(handle));
  assert.equal(all.length, new Set(all).size);
});

test('getOperations returns an array (possibly empty) for any handle', async () => {
  assert.ok(Array.isArray(await getOperations('aquawolf')));
  assert.deepEqual(await getOperations('does-not-exist'), []);
});
