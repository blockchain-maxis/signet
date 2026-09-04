import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WALLET_SOURCES,
  describeWalletSource,
  isWalletSource,
  type WalletSource,
} from './wallet.ts';

test('every source has its own distinct label and marker', () => {
  const labels = WALLET_SOURCES.map((source) => describeWalletSource(source).label);
  const markers = WALLET_SOURCES.map((source) => describeWalletSource(source).marker);

  assert.equal(new Set(labels).size, WALLET_SOURCES.length);
  assert.equal(new Set(markers).size, WALLET_SOURCES.length);
});

test('a CLI-linked wallet is never described as curated', () => {
  const cli = describeWalletSource('cli');

  assert.equal(cli.source, 'cli');
  assert.equal(cli.label, 'CLI-linked');
  assert.doesNotMatch(cli.label, /curated/i);
  assert.match(cli.description, /signature/i);
});

test('on-chain and curated keep the labels they had', () => {
  assert.equal(describeWalletSource('onchain').label, 'on-chain');
  assert.equal(describeWalletSource('onchain').marker, '●');
  assert.equal(describeWalletSource('curated').label, 'curated');
  assert.equal(describeWalletSource('curated').marker, '○');
});

test('an unrecognised source is reported as unknown, not as curated', () => {
  for (const value of ['hardware', '', null, undefined, 42, {}]) {
    const descriptor = describeWalletSource(value);
    assert.equal(descriptor.source, 'unknown');
    assert.doesNotMatch(descriptor.label, /curated/i);
  }
});

test('isWalletSource narrows only the known sources', () => {
  for (const source of WALLET_SOURCES) {
    assert.ok(isWalletSource(source));
  }
  assert.ok(!isWalletSource('CLI'));
  assert.ok(!isWalletSource('hardware'));
  assert.ok(!isWalletSource(undefined));
});

test('the source union stays exhaustive', () => {
  // A new source added to WALLET_SOURCES without a descriptor fails to compile
  // here, so the labels cannot silently fall behind the union.
  const seen: Record<WalletSource, true> = { onchain: true, cli: true, curated: true };
  assert.deepEqual(Object.keys(seen).sort(), [...WALLET_SOURCES].sort());
});
