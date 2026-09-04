#!/usr/bin/env node
/**
 * Pins @signet/cli's own version, and every optionalDependency's version,
 * to the exact release version — so the shim always resolves to the binary
 * package it was actually tested and published against, never a floating
 * range that could drift.
 *
 * Usage:
 *   node scripts/release/pin-shim-version.mjs <version>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('usage: pin-shim-version.mjs <version>');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(here, '../../cli/npm/cli/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

pkg.version = version;
for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
  pkg.optionalDependencies[dep] = version;
}

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `Pinned ${pkg.name}@${version} and its ${Object.keys(pkg.optionalDependencies).length} optional dependencies`,
);
