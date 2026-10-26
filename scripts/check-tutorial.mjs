#!/usr/bin/env node
// Runs the offline commands of docs/SANDBOX_TUTORIAL.md (#643): every
// `signet …` line in its bash blocks that needs no network (--bundle), in
// the current directory, where a signet.dev.toml and .signet/regression.json
// must be (the sandbox-e2e job's sandbox/testdata/e2e). Each must run its
// checks: exit 0 (clean) or 10 (differences found), never a usage, setup or
// simulator error. The online commands are listed, not run.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const tutorial = new URL('../docs/SANDBOX_TUTORIAL.md', import.meta.url);
const text = readFileSync(tutorial, 'utf8');
const commands = [];
let fence = null;
let pending = '';
for (const raw of text.split('\n')) {
  const line = raw.trim();
  if (line.startsWith('```')) {
    fence = fence === null ? line.slice(3) : null;
    continue;
  }
  if (fence !== 'bash') continue;
  pending += pending ? ' ' + line : line;
  if (pending.endsWith('\\')) {
    pending = pending.slice(0, -1).trim();
    continue;
  }
  if (pending.startsWith('signet ')) commands.push(pending);
  pending = '';
}
if (commands.length < 8) {
  console.error(`check-tutorial: found only ${commands.length} commands`);
  process.exit(1);
}
let failed = 0;
for (const command of commands) {
  if (!command.includes('--bundle')) {
    console.log(`  - ${command} (needs the network: not run)`);
    continue;
  }
  const run = spawnSync('bash', ['-c', command], { stdio: 'inherit' });
  const ok = run.status === 0 || run.status === 10;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${command}: exit ${run.status}`);
}
if (failed) process.exit(1);
console.log('check-tutorial: ok');
