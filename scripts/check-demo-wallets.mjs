#!/usr/bin/env node
// Demo-data guard: verifies every demo wallet in `DEMO_PROFILES` still
// resolves on Horizon, so a demo persona whose account has stopped resolving
// surfaces loudly instead of silently breaking its profile page. Exits
// non-zero (naming each offender) when any wallet 404s or Horizon is
// unreachable.
//
// The personas come from packages/types, the one shared source the web app and
// the indexer seed both derive from — imported by relative path so this script
// needs no workspace install. Run it with `node --experimental-strip-types`.
//
// Env:
//   HORIZON_URL   Horizon base (default: testnet — demo data is testnet).

import { DEMO_PROFILES } from '../packages/types/src/index.ts';

const HORIZON_URL = (process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org').replace(
  /\/+$/,
  '',
);

const entries = DEMO_PROFILES.map(({ handle, wallet }) => ({ handle, wallet }));

if (entries.length === 0) {
  console.error('No demo profiles found in DEMO_PROFILES (packages/types)');
  process.exit(1);
}

console.log(`Checking ${entries.length} demo wallet(s) against ${HORIZON_URL}\n`);

let failures = 0;
for (const { handle, wallet } of entries) {
  if (!wallet) {
    console.error(`✗ ${handle}: no wallet address in DEMO_PROFILES`);
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
