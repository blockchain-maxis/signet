#!/usr/bin/env node
// Checks what `npm pack` would publish (#655): the built files and the
// README, and nothing else (no sources, tests or scripts).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const [report] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg, encoding: 'utf8' }),
);
const files = report.files.map((f) => f.path).sort();
const allowed = (f) => f === 'package.json' || f === 'README.md' || f === 'LICENSE' || f.startsWith('dist/');
const extra = files.filter((f) => !allowed(f));
const required = ['dist/index.js', 'dist/index.d.ts', 'dist/browser/signet.min.js', 'README.md'];
const missing = required.filter((f) => !files.includes(f));
if (extra.length || missing.length) {
  if (extra.length) console.error(`check-pack: would publish ${extra.join(', ')}`);
  if (missing.length) console.error(`check-pack: missing ${missing.join(', ')}; run the build first`);
  process.exit(1);
}
console.log(`check-pack: ${files.length} files, ${(report.size / 1024).toFixed(1)} kB packed`);
for (const f of files) console.log(`  ${f}`);
