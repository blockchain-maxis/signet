#!/usr/bin/env node
// Demo-data guard: verifies every demo wallet in
// apps/web/public/data/profiles.json still resolves on Horizon, so a demo
// persona whose account has stopped resolving surfaces loudly instead of
// silently breaking its profile page. Exits non-zero (naming each offender)
// when any wallet 404s or Horizon is unreachable.
//
// Env:
//   HORIZON_URL          Horizon base (default: testnet — demo data is testnet).
//   DEMO_PROFILES_PATH   Override the profiles.json path (for local testing).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HORIZON_URL = (process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org').replace(
  /\/+$/,
  '',
);

const here = dirname(fileURLToPath(import.meta.url));
const profilesPath =
  process.env.DEMO_PROFILES_PATH ?? resolve(here, '..', 'apps/web/public/data/profiles.json');

const profiles = JSON.parse(await readFile(profilesPath, 'utf8'));
const entries = Object.entries(profiles).map(([handle, profile]) => ({
  handle,
  wallet: profile?.wallet,
}));

if (entries.length === 0) {
  console.error(`No demo profiles found in ${profilesPath}`);
  process.exit(1);
}

console.log(`Checking ${entries.length} demo wallet(s) against ${HORIZON_URL}\n`);

let failures = 0;
for (const { handle, wallet } of entries) {
  if (!wallet) {
    console.error(`✗ ${handle}: no wallet address in profiles.json`);
    failures += 1;
    continue;
  }

  let status;
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${wallet}`, {
      headers: { Accept: 'application/json' },
    });
    status = res.status;
  } catch (err) {
    console.error(`✗ ${handle} (${wallet}): Horizon unreachable — ${err.message}`);
    failures += 1;
    continue;
  }

  if (status === 404) {
    console.error(`✗ ${handle} (${wallet}): 404 — demo wallet no longer resolves on Horizon`);
    failures += 1;
  } else if (status !== 200) {
    console.error(`✗ ${handle} (${wallet}): unexpected status ${status}`);
    failures += 1;
  } else {
    console.log(`✓ ${handle} (${wallet}): resolves`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} demo wallet(s) failed to resolve on ${HORIZON_URL}.`);
  process.exit(1);
}

console.log('\nAll demo wallets resolve.');
