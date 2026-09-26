import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORKS,
  isNetwork,
  normalizeNetwork,
  networkPassphrase,
  type Network,
} from './network.ts';

test('NETWORKS contains testnet, mainnet, futurenet, local', () => {
  assert.deepEqual(NETWORKS, ['testnet', 'mainnet', 'futurenet', 'local']);
});

test('isNetwork checks canonical network literals', () => {
  assert.equal(isNetwork('testnet'), true);
  assert.equal(isNetwork('mainnet'), true);
  assert.equal(isNetwork('futurenet'), true);
  assert.equal(isNetwork('local'), true);
  assert.equal(isNetwork('public'), false);
  assert.equal(isNetwork('pubnet'), false);
  assert.equal(isNetwork('unknown'), false);
  assert.equal(isNetwork(null), false);
  assert.equal(isNetwork(undefined), false);
  assert.equal(isNetwork(123), false);
});

test('normalizeNetwork accepts canonical networks and aliases (public, pubnet)', () => {
  assert.equal(normalizeNetwork('testnet'), 'testnet');
  assert.equal(normalizeNetwork('TESTNET'), 'testnet');
  assert.equal(normalizeNetwork('  testnet  '), 'testnet');

  assert.equal(normalizeNetwork('mainnet'), 'mainnet');
  assert.equal(normalizeNetwork('MAINNET'), 'mainnet');
  assert.equal(normalizeNetwork('public'), 'mainnet');
  assert.equal(normalizeNetwork('PUBLIC'), 'mainnet');
  assert.equal(normalizeNetwork('  Public  '), 'mainnet');
  assert.equal(normalizeNetwork('pubnet'), 'mainnet');
  assert.equal(normalizeNetwork('PUBNET'), 'mainnet');
  assert.equal(normalizeNetwork('  Pubnet  '), 'mainnet');

  assert.equal(normalizeNetwork('futurenet'), 'futurenet');
  assert.equal(normalizeNetwork('FUTURENET'), 'futurenet');
  assert.equal(normalizeNetwork('local'), 'local');
  assert.equal(normalizeNetwork('LOCAL'), 'local');
});

test('normalizeNetwork throws on invalid networks', () => {
  assert.throws(() => normalizeNetwork('moonnet'), /Unknown Stellar network: "moonnet"/);
  assert.throws(() => normalizeNetwork(''), /Unknown Stellar network: ""/);
  assert.throws(() => normalizeNetwork('   '), /Unknown Stellar network: " {3}"/);
  assert.throws(() => normalizeNetwork(123 as unknown as string), /Invalid network: expected string/);
});

test('networkPassphrase returns correct SDF passphrases', () => {
  assert.equal(networkPassphrase('testnet'), 'Test SDF Network ; September 2015');
  assert.equal(networkPassphrase('mainnet'), 'Public Global Stellar Network ; September 2015');
  assert.equal(networkPassphrase('futurenet'), 'Test SDF Future Network ; October 2022');
  assert.equal(networkPassphrase('local'), 'Standalone Network ; February 2017');
});
