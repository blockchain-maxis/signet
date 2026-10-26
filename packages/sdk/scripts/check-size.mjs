#!/usr/bin/env node
// Fails when the browser bundle is over its gzipped budget (#655). A
// third-party page pays for every byte, so growth is a decision, made here.
//
//   node scripts/check-size.mjs              # against the budget
//   SDK_BUNDLE_BUDGET=1000 node scripts/check-size.mjs   # try a lower one
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET = Number(process.env.SDK_BUNDLE_BUDGET ?? 12 * 1024);
const file = new URL('../dist/browser/signet.min.js', import.meta.url);
const raw = readFileSync(file);
const gzipped = gzipSync(raw, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const line = `dist/browser/signet.min.js: ${kb(raw.length)} raw, ${kb(gzipped)} gzipped (budget ${kb(BUDGET)})`;
if (gzipped > BUDGET) {
  console.error(`check-size: over budget. ${line}`);
  process.exit(1);
}
console.log(`check-size: ok. ${line}`);
