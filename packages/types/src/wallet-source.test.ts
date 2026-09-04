import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WALLET_SOURCES, isWalletSource, type WalletSource } from './wallet-source.ts';

test('WALLET_SOURCES holds the three known provenance values', () => {
  assert.deepEqual([...WALLET_SOURCES].sort(), ['cli', 'curated', 'onchain']);
});

test('isWalletSource accepts every listed value and rejects everything else', () => {
  for (const value of WALLET_SOURCES) {
    assert.ok(isWalletSource(value), `${value} should be a valid WalletSource`);
  }

  assert.ok(!isWalletSource(''));
  assert.ok(!isWalletSource('database'));
  assert.ok(!isWalletSource('CLI'));
  assert.ok(!isWalletSource('curated '));
});

test('isWalletSource narrows to WalletSource', () => {
  const value: string = 'onchain';
  if (isWalletSource(value)) {
    const narrowed: WalletSource = value;
    assert.equal(narrowed, 'onchain');
  } else {
    assert.fail('onchain should have narrowed');
  }
});
