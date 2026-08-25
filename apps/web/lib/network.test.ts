import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNetwork, stellarExpertAccountUrl, stellarExpertTxUrl } from './network.ts';

test('resolveNetwork maps mainnet to the public explorer segment and Mainnet label', () => {
  const r = resolveNetwork('mainnet');
  assert.equal(r.network, 'mainnet');
  assert.equal(r.explorer, 'public'); // Stellar Expert's mainnet segment is `public`
  assert.equal(r.name, 'Mainnet');
});

test('resolveNetwork treats `public` as an alias for mainnet', () => {
  const r = resolveNetwork('public');
  assert.equal(r.explorer, 'public');
  assert.equal(r.name, 'Mainnet');
});

test('resolveNetwork is case-insensitive', () => {
  assert.equal(resolveNetwork('MAINNET').explorer, 'public');
  assert.equal(resolveNetwork('Testnet').explorer, 'testnet');
});

test('resolveNetwork defaults to testnet when unset', () => {
  const r = resolveNetwork(undefined);
  assert.equal(r.network, 'testnet');
  assert.equal(r.explorer, 'testnet');
  assert.equal(r.name, 'Testnet');
});

test('stellar expert URLs use the /public/ segment on mainnet', () => {
  assert.match(stellarExpertAccountUrl('GABC', 'public'), /\/explorer\/public\/account\/GABC$/);
  assert.match(stellarExpertTxUrl('deadbeef', 'public'), /\/explorer\/public\/tx\/deadbeef$/);
});

test('stellar expert URLs use the /testnet/ segment on testnet', () => {
  assert.match(stellarExpertAccountUrl('GABC', 'testnet'), /\/explorer\/testnet\/account\/GABC$/);
  assert.match(stellarExpertTxUrl('deadbeef', 'testnet'), /\/explorer\/testnet\/tx\/deadbeef$/);
});
