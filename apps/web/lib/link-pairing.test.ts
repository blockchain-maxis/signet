import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_PAIR_TTL_MS, LINK_POLL_INTERVAL_MS } from '@signet/types';
import {
  __resetLinkPairs,
  approveLinkPair,
  createLinkPair,
  getLinkState,
  isValidPairingCode,
  PAIRING_CODE_RE,
} from './link-pairing.ts';

beforeEach(() => {
  __resetLinkPairs();
});

test('createLinkPair mints an 8-char code from the unambiguous alphabet', () => {
  const pair = createLinkPair();
  assert.match(pair.pairingCode, PAIRING_CODE_RE);
  assert.equal(pair.pairingCode.length, 8);
  assert.equal(pair.ttlMs, LINK_PAIR_TTL_MS);
  assert.equal(pair.intervalMs, LINK_POLL_INTERVAL_MS);
  assert.equal(getLinkState(pair.pairingCode), 'pending');
});

test('two created codes differ', () => {
  const a = createLinkPair().pairingCode;
  const b = createLinkPair().pairingCode;
  assert.notEqual(a, b);
});

test('approving flips the state the CLI polls', () => {
  const { pairingCode } = createLinkPair();
  assert.equal(approveLinkPair(pairingCode), 'ok');
  assert.equal(getLinkState(pairingCode), 'approved');
});

test('unknown or malformed codes are rejected and report expired', () => {
  assert.equal(approveLinkPair('NOPE'), 'not-found');
  assert.equal(approveLinkPair('NOPE'), 'not-found');
  assert.equal(getLinkState('NOPE'), 'expired');
  assert.equal(getLinkState(''), 'expired');
  assert.equal(isValidPairingCode('abc12345'), false, 'lowercase not in alphabet');
  assert.equal(isValidPairingCode('ABCDEFG0'), false, '0 is not in the alphabet');
});

test('an expired code cannot be approved and reports expired', () => {
  const { pairingCode } = createLinkPair(-1); // already expired
  assert.equal(approveLinkPair(pairingCode), 'expired');
  assert.equal(getLinkState(pairingCode), 'expired');
});

test('approving twice still reports approved (idempotent from the CLI view)', () => {
  const { pairingCode } = createLinkPair();
  assert.equal(approveLinkPair(pairingCode), 'ok');
  assert.equal(approveLinkPair(pairingCode), 'ok');
  assert.equal(getLinkState(pairingCode), 'approved');
});