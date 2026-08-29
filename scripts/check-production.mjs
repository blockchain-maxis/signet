#!/usr/bin/env node
// Production-site guard: requests the DEPLOYED site and asserts the pages a
// visitor actually hits still serve. CI's e2e suite exercises a local build;
// nothing in it touches the environment variables, middleware CSP, real RPC,
// or CDN that only exist once deployed — so production can 500 while the
// repository stays green. This script is the check that notices.
//
// Four requests, chosen to cover the distinct serving paths:
//   /              the marketing home (static)
//   /handles       the directory (server-rendered, reads the registry)
//   /p/{handle}    a profile page (the product; {handle} is a demo persona
//                  from DEMO_PROFILES so it serves even with an empty DB)
//   /api/health    the liveness/readiness probe ("/health" as a bare path is
//                  not a route — the probe lives under /api)
//
// Exits non-zero naming each offender. A `degraded` health status fails too:
// the endpoint itself stays HTTP 200 on a DB outage so load balancers don't
// kill the pods, but the whole point of THIS job is to tell a human.
//
// The demo personas come from packages/types, imported by relative path so the
// script needs no workspace install. Run with `node --experimental-strip-types`.
//
// Env:
//   PRODUCTION_URL   Site to check (default: the production deployment).
//   PROFILE_HANDLE   Profile to spot-check (default: first demo persona).

import { DEMO_PROFILES } from '../packages/types/src/index.ts';

const BASE = (process.env.PRODUCTION_URL ?? 'https://signet-web-pearl.vercel.app').replace(
  /\/+$/,
  '',
);
const HANDLE = process.env.PROFILE_HANDLE ?? DEMO_PROFILES[0]?.handle;

if (!HANDLE) {
  console.error('No profile handle to check (DEMO_PROFILES is empty and PROFILE_HANDLE unset)');
  process.exit(1);
}

// One retry after a pause: a cold serverless start or transient network blip
// should not page anyone, but two failures a minute apart is a real signal.
async function request(path) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        redirect: 'follow',
        headers: { 'user-agent': 'signet-production-check' },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.text();
      if (res.status >= 500 && attempt === 1) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, body };
    } catch (err) {
      if (attempt >= 2) return { error: err.message ?? String(err) };
      console.log(`  … ${path} failed (${err.message}), retrying in 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}

const checks = [
  { path: '/', expect: (r) => r.status === 200 && r.body.includes('Signet') },
  { path: '/handles', expect: (r) => r.status === 200 && r.body.includes('Directory') },
  { path: `/p/${HANDLE}`, expect: (r) => r.status === 200 && r.body.includes(HANDLE) },
  {
    path: '/api/health',
    expect: (r) => {
      if (r.status !== 200) return false;
      let health;
      try {
        health = JSON.parse(r.body);
      } catch {
        return false;
      }
      // `degraded` means the DB check failed in production — serve-able, but
      // exactly the kind of environment-only breakage this job exists to report.
      return health.status === 'ok';
    },
  },
];

console.log(`Checking production site ${BASE}\n`);

let failures = 0;
for (const { path, expect } of checks) {
  const r = await request(path);
  if (r.error) {
    console.error(`✗ ${path}: unreachable — ${r.error}`);
    failures += 1;
  } else if (!expect(r)) {
    const detail = path === '/api/health' ? ` body: ${r.body.slice(0, 200)}` : '';
    console.error(`✗ ${path}: HTTP ${r.status} — response did not look like the page.${detail}`);
    failures += 1;
  } else {
    console.log(`✓ ${path}: HTTP ${r.status}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} production check(s) failed against ${BASE}.`);
  process.exit(1);
}

console.log('\nProduction site serves all checked pages.');
