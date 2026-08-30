#!/usr/bin/env node
// Wallet-source sync guard: packages/types/generated/wallet_source.go is
// generated from packages/types/src/wallet-source.ts (see
// scripts/generate-wallet-source-go.mjs) so the Go CLI has the same allowed
// Wallet.source values without hand-copying them. Nothing keeps the checked-in
// .go file in sync on its own — this script regenerates it in memory and
// fails when it disagrees with what's committed.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseWalletSources, renderGo } from './generate-wallet-source-go.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const tsPath = resolve(root, 'packages/types/src/wallet-source.ts');
const goPath = resolve(root, 'packages/types/generated/wallet_source.go');

const [tsSource, goSource] = await Promise.all([
  readFile(tsPath, 'utf8'),
  readFile(goPath, 'utf8'),
]);

const values = parseWalletSources(tsSource, tsPath);
const expected = renderGo(values);

if (expected !== goSource) {
  console.error(
    `${goPath.slice(root.length + 1)} is out of sync with ${tsPath.slice(root.length + 1)}.\n` +
      'Run `node scripts/generate-wallet-source-go.mjs` and commit the result.',
  );
  process.exit(1);
}

console.log('wallet_source.go is in sync with wallet-source.ts.');
