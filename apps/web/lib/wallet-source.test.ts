import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walletSourceBadge } from './wallet-source.ts';

test('each source renders its own badge text', () => {
  assert.equal(walletSourceBadge('onchain').text, '● on-chain');
  assert.equal(walletSourceBadge('cli').text, '◆ CLI-linked');
  assert.equal(walletSourceBadge('curated').text, '○ curated');
});

test('a CLI-linked wallet does not render as curated', () => {
  const cli = walletSourceBadge('cli');
  const curated = walletSourceBadge('curated');

  assert.notEqual(cli.text, curated.text);
  assert.notEqual(cli.className, curated.className);
});

test('the three sources are visually distinct from one another', () => {
  const badges = ['onchain', 'cli', 'curated'].map(walletSourceBadge);

  assert.equal(new Set(badges.map((b) => b.text)).size, 3);
  assert.equal(new Set(badges.map((b) => b.className)).size, 3);
});

test('an unknown source falls back to the muted, unrecognised badge', () => {
  const badge = walletSourceBadge('hardware');

  assert.equal(badge.source, 'unknown');
  assert.equal(badge.text, '◌ unrecognised');
  assert.doesNotMatch(badge.text, /curated/i);
});
