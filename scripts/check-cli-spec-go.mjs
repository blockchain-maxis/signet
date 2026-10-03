#!/usr/bin/env node
// CLI spec sync guard: cli/internal/spec/zz_generated_api.go is generated from
// packages/types/src/cli-api.ts (see scripts/generate-cli-spec-go.mjs) so the
// Go CLI decodes the same bodies and failure codes the routes produce. Nothing
// keeps the checked-in .go file in sync on its own — this script regenerates
// it in memory and fails when it disagrees with what's committed.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { generate, goPath, tsPath } from './generate-cli-spec-go.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const expected = await generate();
// A Windows checkout with core.autocrlf has CRLF on disk; the committed file
// (and the generator's output) is LF. Compare content, not line endings.
const actual = (await readFile(goPath, 'utf8')).replace(/\r\n/g, '\n');

if (expected !== actual) {
  console.error(
    `${goPath.slice(root.length + 1)} is out of sync with ${tsPath.slice(root.length + 1)}.\n` +
      'Run `node scripts/generate-cli-spec-go.mjs` and commit the result.',
  );
  process.exit(1);
}

console.log('zz_generated_api.go is in sync with cli-api.ts.');
