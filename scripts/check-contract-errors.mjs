#!/usr/bin/env node
// Contract-error sync guard: the Identity Registry's `Error` enum
// (packages/contracts/identity-registry/src/lib.rs) is mirrored by hand in
// apps/web/lib/contract-errors.ts so the frontend can show a human-readable
// message for each on-chain failure. Nothing keeps the two in sync — adding a
// variant to the Rust enum silently falls back to the generic unknown-code
// message in the UI. This script parses both sides and fails when they drift.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const rustPath = resolve(root, 'packages/contracts/identity-registry/src/lib.rs');
const tsPath = resolve(root, 'apps/web/lib/contract-errors.ts');

function parseRustEnum(source, file) {
  const enumMatch = source.match(/pub enum Error \{([^}]*)\}/s);
  if (!enumMatch) {
    console.error(`${file}: could not find \`pub enum Error { ... }\``);
    process.exit(1);
  }

  const body = enumMatch[1];
  const variants = new Map(); // code -> variant name
  const variantRe = /(\w+)\s*=\s*(\d+)\s*,/g;
  let m;
  while ((m = variantRe.exec(body))) {
    const [, name, code] = m;
    variants.set(Number(code), name);
  }

  if (variants.size === 0) {
    console.error(`${file}: found the Error enum but parsed zero variants`);
    process.exit(1);
  }

  return variants;
}

function parseTsMap(source, file) {
  const objMatch = source.match(
    /const CONTRACT_ERROR_MESSAGES: Record<number, string> = \{([^}]*)\}/s,
  );
  if (!objMatch) {
    console.error(`${file}: could not find \`CONTRACT_ERROR_MESSAGES\``);
    process.exit(1);
  }

  const body = objMatch[1];
  const codes = new Set();
  const entryRe = /^\s*(\d+)\s*:/gm;
  let m;
  while ((m = entryRe.exec(body))) {
    codes.add(Number(m[1]));
  }

  return codes;
}

const [rustSource, tsSource] = await Promise.all([
  readFile(rustPath, 'utf8'),
  readFile(tsPath, 'utf8'),
]);

const rustVariants = parseRustEnum(rustSource, rustPath);
const tsCodes = parseTsMap(tsSource, tsPath);

const missing = [...rustVariants.entries()]
  .filter(([code]) => !tsCodes.has(code))
  .sort((a, b) => a[0] - b[0]);
const extra = [...tsCodes]
  .filter((code) => !rustVariants.has(code))
  .sort((a, b) => a - b);

function rel(p) {
  return p.slice(root.length + 1).split('\\').join('/');
}

if (missing.length === 0 && extra.length === 0) {
  console.log(
    `contract-errors check ok — ${rustVariants.size} Error variant(s) match ${rel(tsPath)}`,
  );
  process.exit(0);
}

console.error('contract-errors check failed — Rust Error enum and CONTRACT_ERROR_MESSAGES have drifted:\n');

for (const [code, name] of missing) {
  console.error(`  missing: code ${code} (${name}) is in the Rust enum but has no message in contract-errors.ts`);
}
for (const code of extra) {
  console.error(`  extra:   code ${code} is in contract-errors.ts but no longer exists in the Rust enum`);
}

console.error('\nUpdate CONTRACT_ERROR_MESSAGES in apps/web/lib/contract-errors.ts to match.');
process.exit(1);
