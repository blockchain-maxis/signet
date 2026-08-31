import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNetwork } from './network.ts';

function formatWalletBadge(network: string): string {
  const resolved = resolveNetwork(network);
  return `connected · ${resolved.network}`;
}

test('formatWalletBadge displays testnet for testnet configuration', () => {
  assert.equal(formatWalletBadge('testnet'), 'connected · testnet');
  assert.equal(formatWalletBadge(undefined as unknown as string), 'connected · testnet');
});

test('formatWalletBadge displays mainnet for mainnet configuration', () => {
  assert.equal(formatWalletBadge('mainnet'), 'connected · mainnet');
  assert.equal(formatWalletBadge('MAINNET'), 'connected · mainnet');
});

test('formatWalletBadge displays public for public alias configuration', () => {
  assert.equal(formatWalletBadge('public'), 'connected · public');
});

test('formatWalletBadge displays futurenet for futurenet configuration', () => {
  assert.equal(formatWalletBadge('futurenet'), 'connected · futurenet');
});
