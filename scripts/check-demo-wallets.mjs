#!/usr/bin/env node
// Demo-data guard: checks the demo personas in `DEMO_PROFILES` against the
// things that are actually true today, so a red run means something CHANGED
// rather than restating a known, unfixed state.
//
// Two tiers, deliberately:
//
//   Enforced (exit non-zero) — invariants the repository controls:
//     * every persona has a well-formed Stellar account address
//     * no two personas share an address
//     * each persona has an activity fixture whose every record's
//       `source_account` is that persona's address
//   These are what drift when the personas are edited or refactored (see #138,
//   which moved the personas out of `profiles.json` and into `DEMO_PROFILES`).
//
//   Advisory (reported, exit 0) — Horizon resolution:
//     The demo accounts are synthetic and have never been funded on testnet, so
//     `GET /accounts/{wallet}` 404s for all of them. That is a known data gap
//     tracked by #56 (generate the personas from real, funded testnet activity),
//     not a change worth a red run every night. Once #56 lands, set
//     DEMO_WALLETS_REQUIRE_HORIZON=1 and a 404 fails the workflow again.
//
// The personas come from packages/types, the one shared source the web app and
// the indexer seed both derive from — imported by relative path so this script
// needs no workspace install. Run it with `node --experimental-strip-types`.
//
// Env:
//   HORIZON_URL                   Horizon base (default: testnet — demo data is testnet).
//   DEMO_WALLETS_REQUIRE_HORIZON  `1`/`true` -> Horizon resolution is enforced.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEMO_PROFILES } from '../packages/types/src/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(ROOT, 'apps/web/public/data');

const HORIZON_URL = (process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org').replace(
  /\/+$/,
  '',
);

const REQUIRE_HORIZON = /^(1|true|yes)$/i.test(process.env.DEMO_WALLETS_REQUIRE_HORIZON ?? '');

/** A Stellar ed25519 account address: `G` followed by 55 base32 characters. */
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;

const failures = [];
const notices = [];

function fail(message) {
  failures.push(message);
  console.error(`x ${message}`);
}

function notice(message) {
  notices.push(message);
  console.log(`- ${message}`);
}

if (DEMO_PROFILES.length === 0) {
  console.error('No demo profiles found in DEMO_PROFILES (packages/types)');
  process.exit(1);
}

// -- Enforced: addresses are well-formed and unique -------------------

console.log(`Checking ${DEMO_PROFILES.length} demo persona(s)\n`);

/** wallet -> the first handle that used it, for the duplicate check. */
const seen = new Map();

for (const { handle, wallet } of DEMO_PROFILES) {
  if (!wallet) {
    fail(`${handle}: no wallet address in DEMO_PROFILES`);
    continue;
  }
  if (!ACCOUNT_RE.test(wallet)) {
    fail(`${handle} (${wallet}): not a well-formed Stellar account address`);
    continue;
  }
  const owner = seen.get(wallet);
  if (owner) {
    fail(`${handle} (${wallet}): address is already used by ${owner}`);
    continue;
  }
  seen.set(wallet, handle);
  console.log(`ok ${handle} (${wallet}): address well-formed`);
}

// -- Enforced: fixtures agree with the personas ----------------------

console.log('');

for (const { handle, wallet } of DEMO_PROFILES) {
  if (!wallet || !ACCOUNT_RE.test(wallet)) continue;

  const fixture = path.join(FIXTURE_DIR, `${handle}.json`);
  if (!fs.existsSync(fixture)) {
    fail(`${handle}: no activity fixture at apps/web/public/data/${handle}.json`);
    continue;
  }

  let records;
  try {
    const parsed = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    records = parsed?._embedded?.records;
  } catch (err) {
    fail(`${handle}: fixture is not valid JSON — ${err.message}`);
    continue;
  }

  if (!Array.isArray(records) || records.length === 0) {
    fail(`${handle}: fixture has no _embedded.records array`);
    continue;
  }

  const mismatched = records.filter((r) => r?.source_account && r.source_account !== wallet);
  if (mismatched.length > 0) {
    const sample = mismatched[0].source_account;
    fail(
      `${handle}: ${mismatched.length} of ${records.length} fixture record(s) carry a ` +
        `source_account that is not the persona's wallet (e.g. ${sample})`,
    );
    continue;
  }

  console.log(`ok ${handle}: ${records.length} fixture record(s) match the persona wallet`);
}

// -- Horizon resolution: enforced only once the accounts are real -----

console.log(
  `\n${REQUIRE_HORIZON ? 'Checking' : 'Reporting (advisory)'} Horizon resolution against ${HORIZON_URL}\n`,
);

let unresolved = 0;
let resolved = 0;

for (const { handle, wallet } of DEMO_PROFILES) {
  if (!wallet || !ACCOUNT_RE.test(wallet)) continue;

  let status;
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${wallet}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
  } catch (err) {
    const message = `${handle} (${wallet}): Horizon unreachable — ${err.message}`;
    if (REQUIRE_HORIZON) fail(message);
    else notice(message);
    continue;
  }

  if (status === 200) {
    resolved += 1;
    console.log(`ok ${handle} (${wallet}): resolves`);
  } else if (status === 404) {
    unresolved += 1;
    const message = `${handle} (${wallet}): 404 — account does not exist on ${HORIZON_URL}`;
    if (REQUIRE_HORIZON) fail(message);
    else notice(message);
  } else {
    const message = `${handle} (${wallet}): unexpected status ${status}`;
    if (REQUIRE_HORIZON) fail(message);
    else notice(message);
  }
}

// -- Summary ---------------------------------------------------------

const summary = [];

if (!REQUIRE_HORIZON && unresolved > 0) {
  summary.push(
    `${unresolved} demo wallet(s) do not exist on ${HORIZON_URL}. This is the known, ` +
      'unfixed state tracked by issue #56 (generate the demo personas from real, funded ' +
      'testnet activity), so it is reported rather than failed. Explorer links for those ' +
      'personas stay dead until then.',
  );
}

if (!REQUIRE_HORIZON && resolved === DEMO_PROFILES.length) {
  summary.push(
    'Every demo wallet now resolves on Horizon, so the demo data is real. Set the repository ' +
      'variable DEMO_WALLETS_REQUIRE_HORIZON to 1 so a future 404 fails this workflow again.',
  );
}

for (const line of summary) console.log(`\n${line}`);

// Surface the advisory state on the workflow run itself, so a green run still
// says what it did and did not verify instead of looking unconditionally fine.
if (process.env.GITHUB_ACTIONS) {
  for (const line of summary) console.log(`::notice title=Demo data::${line}`);

  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    const body = [
      '### Demo data check',
      '',
      `- Personas checked: ${DEMO_PROFILES.length}`,
      `- Repository invariants: ${failures.length === 0 ? 'pass' : `${failures.length} failure(s)`}`,
      `- Horizon resolution: ${REQUIRE_HORIZON ? 'enforced' : 'advisory'} — ${resolved} resolve, ${unresolved} do not exist`,
      ...(notices.length > 0 ? ['', 'Advisory:', '', ...notices.map((n) => `- ${n}`)] : []),
      ...(summary.length > 0 ? ['', ...summary.map((s) => `> ${s}`)] : []),
      '',
    ].join('\n');
    try {
      fs.appendFileSync(stepSummary, body);
    } catch {
      /* a missing or unwritable summary file must never fail the guard */
    }
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} demo-data check(s) failed.`);
  process.exit(1);
}

console.log('\nDemo data is internally consistent.');
