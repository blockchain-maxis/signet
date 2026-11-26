'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const PLATFORM_PACKAGES = {
  'linux-x64': '@signet/cli-linux-x64',
  'linux-arm64': '@signet/cli-linux-arm64',
  'darwin-arm64': '@signet/cli-darwin-arm64',
  'darwin-x64': '@signet/cli-darwin-x64',
  'win32-x64': '@signet/cli-windows-x64',
};

test('npm shim forwards __complete arguments unchanged to the platform binary', (t) => {
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) {
    t.skip(`unsupported platform ${key}`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signet-shim-test-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pkgDir = path.join(tmpDir, 'node_modules', ...pkg.split('/'), 'bin');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'node_modules', ...pkg.split('/'), 'package.json'),
    JSON.stringify({ name: pkg, version: '0.0.0' }),
    'utf8',
  );

  const isWin = process.platform === 'win32';
  const binPath = path.join(pkgDir, isWin ? 'signet.exe' : 'signet');
  const script = `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });

  // On Windows, spawnSync cannot execute a shebang script as a .exe without a real PE header.
  // Preload a tiny hook in the child Node process that routes spawnSync(binPath, args) to node.
  const preloadPath = path.join(tmpDir, 'preload.js');
  fs.writeFileSync(
    preloadPath,
    [
      'const cp = require("node:child_process");',
      'const orig = cp.spawnSync;',
      'cp.spawnSync = function (file, args, opts) {',
      '  if (process.platform === "win32" && typeof file === "string" && file.endsWith("signet.exe")) {',
      '    return orig.call(this, process.execPath, [file, ...(args || [])], opts);',
      '  }',
      '  return orig.apply(this, arguments);',
      '};',
    ].join('\n'),
    'utf8',
  );

  const shimPath = path.resolve(__dirname, 'signet.js');
  const forwardedArgs = ['__complete', 'link', '--source', ''];
  const res = childProcess.spawnSync(
    process.execPath,
    ['--require', preloadPath, shimPath, ...forwardedArgs],
    {
      cwd: tmpDir,
      env: { ...process.env, NODE_PATH: path.join(tmpDir, 'node_modules') },
      encoding: 'utf8',
    },
  );

  assert.equal(res.status, 0, `shim exited with ${res.status}: ${res.stderr}`);
  assert.deepEqual(JSON.parse(res.stdout), forwardedArgs);
});

test('npm shim prints supported platforms list when platform is unsupported', (t) => {
  const shimPath = path.resolve(__dirname, 'signet.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signet-shim-test-unsupported-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const preloadPath = path.join(tmpDir, 'preload-unsupported.js');
  fs.writeFileSync(
    preloadPath,
    'Object.defineProperty(process, "platform", { value: "unsupportedos" });',
    'utf8',
  );

  const res = childProcess.spawnSync(
    process.execPath,
    ['--require', preloadPath, shimPath],
    {
      cwd: tmpDir,
      encoding: 'utf8',
    },
  );

  assert.equal(res.status, 1, `shim exited with ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /signet: no prebuilt binary for unsupportedos-/);
  assert.match(res.stderr, /Supported platforms: linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64/);
});

test('on POSIX: a fake binary without execute bit produces stderr error and exit 1', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX only');
    return;
  }
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) {
    t.skip(`unsupported platform ${key}`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signet-shim-test-eacces-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pkgDir = path.join(tmpDir, 'node_modules', ...pkg.split('/'), 'bin');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'node_modules', ...pkg.split('/'), 'package.json'),
    JSON.stringify({ name: pkg, version: '0.0.0' }),
    'utf8',
  );

  const binPath = path.join(pkgDir, 'signet');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o644 });

  const shimPath = path.resolve(__dirname, 'signet.js');
  const res = childProcess.spawnSync(process.execPath, [shimPath], {
    cwd: tmpDir,
    env: { ...process.env, NODE_PATH: path.join(tmpDir, 'node_modules') },
    encoding: 'utf8',
  });

  assert.equal(res.status, 1, `shim exited with ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /signet: could not run .*?: EACCES/);
  assert.match(res.stderr, /Try reinstalling/);
});

test('on POSIX: a fake binary that kills itself with SIGTERM makes shim exit 143', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX only');
    return;
  }
  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (!pkg) {
    t.skip(`unsupported platform ${key}`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signet-shim-test-signal-'));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const pkgDir = path.join(tmpDir, 'node_modules', ...pkg.split('/'), 'bin');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'node_modules', ...pkg.split('/'), 'package.json'),
    JSON.stringify({ name: pkg, version: '0.0.0' }),
    'utf8',
  );

  const binPath = path.join(pkgDir, 'signet');
  fs.writeFileSync(binPath, '#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n', { mode: 0o755 });

  const shimPath = path.resolve(__dirname, 'signet.js');
  const res = childProcess.spawnSync(process.execPath, [shimPath], {
    cwd: tmpDir,
    env: { ...process.env, NODE_PATH: path.join(tmpDir, 'node_modules') },
    encoding: 'utf8',
  });

  assert.equal(res.status, 143, `shim exited with ${res.status}: ${res.stderr}`);
});
