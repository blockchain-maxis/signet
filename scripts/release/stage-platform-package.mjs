#!/usr/bin/env node
/**
 * Stages one `@signet/cli-<platform>` npm package for release: copies the
 * freshly built Go binary and Rust simulator binary into its `bin/` directory
 * and pins the package's own `version` field.
 *
 * Usage:
 *   node scripts/release/stage-platform-package.mjs <package-dir> <binary-path> <simulator-path> <version>
 *
 * Example (from the repo root):
 *   node scripts/release/stage-platform-package.mjs \
 *     cli/npm/cli-linux-x64 cli/dist/signet cli/dist/signet-simulator 0.1.0
 */
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , packageDir, binaryPath, simulatorPath, version] = process.argv;

if (!packageDir || !binaryPath || !simulatorPath || !version) {
  console.error('usage: stage-platform-package.mjs <package-dir> <binary-path> <simulator-path> <version>');
  process.exit(1);
}

// Stage Go CLI binary (`signet` or `signet.exe`)
const binName = binaryPath.toLowerCase().endsWith('.exe') ? 'signet.exe' : 'signet';
const dest = path.join(packageDir, 'bin', binName);
copyFileSync(binaryPath, dest);
chmodSync(dest, 0o755); // no-op on Windows; required for the binary to exec on Linux/macOS
console.log(`Staged ${dest} into ${packageDir}`);

// Stage Rust simulator binary (`signet-simulator` or `signet-simulator.exe`)
const simBinName = simulatorPath.toLowerCase().endsWith('.exe') ? 'signet-simulator.exe' : 'signet-simulator';
const simDest = path.join(packageDir, 'bin', simBinName);
copyFileSync(simulatorPath, simDest);
chmodSync(simDest, 0o755);
console.log(`Staged ${simDest} into ${packageDir}`);

const pkgPath = path.join(packageDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Staged binaries and version into ${pkg.name}@${version}`);
