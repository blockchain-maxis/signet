#!/usr/bin/env node
'use strict';

/**
 * Zero-dependency shim: `npx` executes JavaScript from the npm registry and
 * cannot run a Go binary directly, so this resolves the one prebuilt
 * `@signet/cli-<platform>` optionalDependency npm already installed for the
 * caller's platform, and execs it — the same wrapper pattern esbuild, swc,
 * and turbo use. All the real behavior (and every exit code) is the Go
 * binary's; this file only finds it.
 */

const { execFileSync } = require('node:child_process');

/** node's platform-arch pair -> the npm package that ships that binary. */
const PLATFORM_PACKAGES = {
  'linux-x64': '@signet/cli-linux-x64',
  'linux-arm64': '@signet/cli-linux-arm64',
  'darwin-arm64': '@signet/cli-darwin-arm64',
  'win32-x64': '@signet/cli-windows-x64',
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

function resolveBinary() {
  const key = platformKey();
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) {
    console.error(
      `signet: no prebuilt binary for ${key}. Supported platforms: ${Object.keys(PLATFORM_PACKAGES).join(', ')}.`,
    );
    process.exit(1);
  }

  const binName = process.platform === 'win32' ? 'signet.exe' : 'signet';
  try {
    return require.resolve(`${pkg}/bin/${binName}`);
  } catch {
    console.error(
      `signet: could not find the ${pkg} package. npm should install it automatically as an ` +
        'optional dependency for your platform — try reinstalling (npm install --force), or ' +
        'file an issue if this persists.',
    );
    process.exit(1);
  }
}

const binaryPath = resolveBinary();

try {
  execFileSync(binaryPath, process.argv.slice(2), { stdio: 'inherit' });
} catch (err) {
  // execFileSync throws even for a clean non-zero exit from the child; forward
  // its real exit code so `npx @signet/cli link ...; echo $?` still works in CI.
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
