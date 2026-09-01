# Maintainer TODO

Priority-ordered launch checklist. The codebase is deploy-ready; everything below
is operational. Items 1–2 close the loop (live on-chain depth + live product
surface) and must land **before the next funding-wave entry (~Jul 23, 2026)** —
work finished after entry is invisible for a full cycle.

## 1. Deploy the Identity Registry to testnet — DONE ✅
10019609
- Deployed + initialized on testnet: `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`
  (admin key alias `signet`). Set in local `.env`; notes + setup steps in
  `.env.example`.
- Effect: the "Claim your handle" flow flips from the honest "Phase 2" message to
  live on-chain claims, and the attestation worker stops no-oping.
- Still open: claim a handle from the deployed UI with a testnet wallet; confirm
  the `claimed` event lands and `resolve`/`lookup` return the binding (needs a
  browser + wallet against the live site from item 2).

## 2. Publish the web app

- `netlify.toml` is ready — connect the repo and push. (Vercel works too.)
- Set the production env vars from `.env.example`, including the contract id
  from step 1 and `SIGNET_AUTH_SECRET` (≥16 chars, required in production).
- Effect: a live URL a stranger can use today — demo profiles plus a working
  on-chain claim.
- Verify: `/`, `/p/aquawolf`, `/how-it-works` return 200 in production; claim
  flow works against testnet from the hosted site.

## 3. (Optional) Provision Postgres + run the indexer

- Point `apps/indexer/Dockerfile` at a managed Postgres; it runs
  `prisma migrate deploy` then starts the worker.
- Effect: `/p` pages become DB-preferred with live activity history
  (`safeDbProfile` fallback already wired). Nice to have — not required for
  the two items above.

## Later (after the Jul 23 entry)

- **SEP-10 web auth**: the current sign-in (SIWS in `apps/web/lib/auth.ts`) is a
  custom challenge/verify, not SEP-10. Implementing the real SEP raises
  protocol-standard depth.
- **Grant framing**: proposal with itemized budget buckets + milestones.
- Monitoring provider wired to `/health` + structured logs (Sentry/OTel).
- Contract audit before any mainnet deployment.
- Dashboard polish, CSP nonce hardening, more docs/tests.

## Explicitly deferred — do NOT prioritize before the entry date

More documentation, additional tests, CSP hardening, the audit, and dashboard
polish do not change the project's standing while the loop is open. Deploy
first (items 1–2); everything else comes after.
