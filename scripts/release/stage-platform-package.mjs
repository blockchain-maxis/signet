#!/usr/bin/env node
/**
 * Stages one `@signet/cli-<platform>` npm package for release: copies the
 * freshly built Go binary into its `bin/` directory and pins the package's
 * own `version` field.
 *
 * Usage:
 *   node scripts/release/stage-platform-package.mjs <package-dir> <binary-path> <version>
 *
 * Example (from the repo root, after `go build` produced cli/dist/signet):
 *   node scripts/release/stage-platform-package.mjs \
 *     cli/npm/cli-linux-x64 cli/dist/signet 0.1.0
 */
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , packageDir, binaryPath, version] = process.argv;

if (!packageDir || !binaryPath || !version) {
  console.error('usage: stage-platform-package.mjs <package-dir> <binary-path> <version>');
  process.exit(1);
}

// Always named exactly `signet`/`signet.exe` in the published package,
// regardless of what the build step happened to name the source file (the
// release workflow disambiguates build outputs per-target with a prefix) —
// this is the one name cli/npm/cli/bin/signet.js's shim ever looks for.
const binName = binaryPath.toLowerCase().endsWith('.exe') ? 'signet.exe' : 'signet';
const dest = path.join(packageDir, 'bin', binName);
copyFileSync(binaryPath, dest);
chmodSync(dest, 0o755); // no-op on Windows; required for the binary to exec on Linux/macOS

const pkgPath = path.join(packageDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Staged ${dest} into ${pkg.name}@${version}`);
