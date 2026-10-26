#!/usr/bin/env node
// Builds the publishable package (#655):
//
//   dist/                     ESM + .d.ts, from tsc (tsconfig.build.json)
//   dist/browser/signet.min.js  one minified ESM file for browsers, from esbuild
//
// The sources import each other as `./x.ts`. tsc rewrites those to `.js` in
// the JavaScript; the declarations keep `.ts`, which a consumer outside the
// monorepo cannot resolve, so they are rewritten here.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const dist = join(pkg, 'dist');

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(pkg, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
  cwd: pkg,
  stdio: 'inherit',
});

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
for (const file of walk(dist).filter((f) => f.endsWith('.d.ts'))) {
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(/(from\s+'\.{1,2}\/[^']+)\.ts'/g, "$1.js'"));
}

// platform: 'browser' fails the build on any Node built-in import.
await build({
  entryPoints: [join(pkg, 'src/index.ts')],
  outfile: join(dist, 'browser/signet.min.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  // SignetError names itself from new.target.name; keep the class names.
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('built dist/ and dist/browser/signet.min.js');
