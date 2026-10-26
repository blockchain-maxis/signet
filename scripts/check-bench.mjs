#!/usr/bin/env node
// Compares the reload-cycle benchmarks (#638) with the committed baseline:
// any benchmark whose median is more than 30% slower fails the check.
//
//   cargo bench -p signet-simulator --bench cycle --no-default-features --features lane-p28
//   node scripts/check-bench.mjs            # compare
//   node scripts/check-bench.mjs --write    # make these numbers the baseline
//
// Shared runners differ in speed from run to run, often by more than 30%
// across the board. So each median is compared relative to `calibration`, a
// fixed piece of CPU work with no simulator in it, measured in the same run:
// a machine 30% slower makes calibration 30% slower too, and cancels out.
// What is left is noise of about 10%, hence the 30% threshold, on medians.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const baselinePath = join(root, 'sandbox/simulator/benches/baseline.json');
const criterion = join(root, 'sandbox/target/criterion/cycle');
const threshold = 0.3;
const write = process.argv.includes('--write');

function median(name) {
  const path = join(criterion, name, 'new', 'estimates.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')).median.point_estimate;
}

const fmt = (ns) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : `${(ns / 1e3).toFixed(1)} µs`);
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

if (write) {
  for (const name of Object.keys(baseline.benchmarks)) {
    const now = median(name);
    if (now === null) {
      console.error(`check-bench: no result for ${name}; run the benchmarks first`);
      process.exit(1);
    }
    baseline.benchmarks[name] = Math.round(now);
  }
  baseline.runner = process.env.BENCH_RUNNER ?? baseline.runner;
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(
    `check-bench: wrote ${Object.keys(baseline.benchmarks).length} medians to the baseline`,
  );
  process.exit(0);
}

if (!baseline.benchmarks.calibration) {
  console.log(
    'check-bench: the baseline has no calibration yet; commit the medians the next step prints',
  );
  process.exit(0);
}

// scale is how much slower this machine is than the baseline's.
const baseCalibration = baseline.benchmarks.calibration;
const nowCalibration = median('calibration');
const scale = baseCalibration && nowCalibration ? nowCalibration / baseCalibration : 1;
console.log(
  `  this machine runs calibration at ${(scale * 100).toFixed(0)}% of the baseline's time`,
);

let failed = 0;
for (const [name, base] of Object.entries(baseline.benchmarks)) {
  if (name === 'calibration') continue;
  const now = median(name);
  if (now === null) {
    console.log(`  ${name}: no result`);
    failed++;
    continue;
  }
  const change = now / scale / base - 1;
  const bad = change > threshold;
  if (bad) failed++;
  const sign = change >= 0 ? '+' : '';
  console.log(
    `  ${bad ? '✗' : '✓'} ${name}: ${fmt(now)} (baseline ${fmt(base)}; ${sign}${(change * 100).toFixed(1)}% relative to calibration)`,
  );
}
if (failed) {
  console.error(
    `check-bench: ${failed} benchmark(s) regressed more than ${threshold * 100}% against ${baseline.runner}, or did not run`,
  );
  process.exit(1);
}
console.log(`check-bench: ok against ${baseline.runner}`);
