# Signet

Signet is a verifiable developer career record built on Stellar/Soroban. Developers link their deployment wallets to a profile; on-chain attestations bind wallet → identity; an indexer pulls every contract they've deployed along with its activity. Public profiles become the canonical record of a developer's smart-contract career.

## Live demo

> Demo profiles use **synthetic data on Stellar testnet** — generated, unowned
> accounts — so no real wallet's activity is attributed to an invented persona.
> Production renders real mainnet activity bound on-chain via the Identity Registry.
> Provenance, schema, regeneration, and the honesty policy:
> [`docs/DEMO_DATA.md`](docs/DEMO_DATA.md).

| URL | Description |
|-----|-------------|
| `/` | Landing page with "See it in action" section |
| `/p/aquawolf` | Demo profile — Blend-style collateral ops (testnet, synthetic) |
| `/p/sorobuilder` | Demo profile — Soroswap-style DEX swaps (testnet, synthetic) |
| `/p/stellardev` | Demo profile — USDC token transfers (testnet, synthetic) |
| `/how-it-works` | How Signet works + what's coming |
| [`docs/DEMO_DATA.md`](docs/DEMO_DATA.md) | Demo fixture provenance, schema, and honesty policy |

## What's working in this build

- **Landing page** — polished marketing page with animated sections and a live "See it in action" demos block linking to the 3 profiles
- **Demo profiles at `/p/{handle}`** — server-rendered (SSG) profile pages reading synthetic testnet operation data from `apps/web/public/data/{handle}.json`; clearly labelled as demo data
- **How it works page** — explains the thesis, what's live, and what's coming
- **Middleware routing** — `/p/` and `/how-it-works` pass through; handles validated; legacy `/profile/` redirects to `/p/`
- **Production data path** — the same UI renders real Horizon API data on mainnet once the indexer + registry are live (`safeDbProfile` already wires the DB-with-static fallback)

## Also implemented

- **On-chain Identity Registry** — a real Soroban contract (`packages/contracts/identity-registry`) binds a wallet to a handle via a signed `claim`; ownership is enforced by `require_auth`. 13 unit tests, builds to wasm.
- **Wallet connect + claim flow** — `Connect wallet` / `Claim your handle` use Stellar Wallets Kit and submit the on-chain claim (`apps/web/lib/{wallet,registry}.ts`). Until the registry's contract id is configured (`NEXT_PUBLIC_IDENTITY_REGISTRY_ID`), the claim surfaces an honest "Phase 2" message.
- **Real API + SDK** — tRPC `profile.byHandle` / `profile.list` / `health`; `@signet/sdk` fetches them. Both covered by tests.
- **CI gates** lint · typecheck · test · build, plus a Rust contract job.

## What's coming next (Phase 2)

- **Deploy the registry** to testnet/mainnet and set `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` to make claims live.
- **Run the indexer** against a Postgres instance to populate full deployment/activity history; `/p` already has a DB-with-static-fallback loader (`safeDbProfile`).
- **Self-sovereign bindings** replace the curated `DEMO_PROFILES` mapping once claims are live.
- **Developer dashboard** (`/app/*`) — currently an honest read-only preview pending wallet auth.
- **Reputation scoring** — attestations, TVL tracking, incident records.

## Run locally

```bash
git clone <repo> signet && cd signet
pnpm install

# Run just the web app (no database needed for the demo routes)
pnpm --filter @signet/web dev
```

Visit `http://localhost:3000` for the landing page.
Visit `http://localhost:3000/p/aquawolf` for the first demo profile.

> **Requires Node 22+.** Fonts (`IBM Plex Sans`/`Mono`) load via a browser-side `@import` in `globals.css` (not `next/font`), so the build never blocks on font downloads.

First-run failures (stellar CLI passphrase bug, Friendbot funding, missing
`wasm32v1-none`, no `DATABASE_URL`, Phase 2 claim message, indexer without a
registry id): see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Self-host / deploy

**See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** for a clone-to-running guide:
prerequisites, deploy key + Friendbot, wasm build, `infra/deploy-contract.sh`,
`initialize(admin)`, Netlify (`netlify.toml`) and Vercel production env
(including `SIGNET_AUTH_SECRET`), verification checklist, and rollback.

## Roadmap and funding

**See [`PROPOSAL.md`](PROPOSAL.md)** for the grant proposal: the problem
statement, an itemized budget, dated milestones through 2027-04-30, and a
fix-log of resolved issues with the tests that keep them closed.

## Architecture

**See [`ARCHITECTURE.md`](ARCHITECTURE.md)** for the real data flows
(`claim → event → attestation → DB` and `wallet → operations → DB`), the read
path, and a precise breakdown of what is **deployed** vs **operational-only**.
The two flows are code-complete; the diagram below sketches how the pieces fit.

```
┌─────────────────────────────────────────────────────┐
│                    apps/web (Next.js)                │
│  /p/{handle}   — canonical profile (static + DB-opt) │
│  /profile/{handle} — legacy alias → redirects to /p  │
└───────────────────┬─────────────────────────────────┘
                    │
          ┌─────────▼─────────┐
          │   apps/indexer    │   Long-running worker
          │ (TypeScript)      │   polls Horizon API,
          │                   │   writes to Postgres
          └─────────┬─────────┘
                    │
          ┌─────────▼─────────┐
          │   packages/db     │   Prisma schema
          │   (PostgreSQL)    │   Profile, Wallet,
          │                   │   Contract, Snapshot
          └───────────────────┘

Implemented:
  packages/contracts/identity-registry  — Soroban claim contract (13 tests)
  packages/sdk                          — External SDK (fetches the tRPC API)
```

## Running the indexer

**See [`docs/INDEXER.md`](docs/INDEXER.md)** — the operator runbook: what each worker
does, how cursors and the ledger-window cold start work, every `INDEXER_*` setting,
running locally and in Docker, what the structured log lines mean, and a troubleshooting
table for the common failures.

## Integrating with the registry

**See [`docs/REGISTRY_INTEGRATION.md`](docs/REGISTRY_INTEGRATION.md)** to resolve Signet
handles from your own app: the deployed testnet contract id and passphrase, every
`contracterror` code, the event topic/data layout, and `@stellar/stellar-sdk` snippets for
reading (`resolve` / `lookup` / `is_bound` / `count`), claiming, and rebuilding the handle
set from the event stream.

## Directory structure

| Path | Purpose |
|------|---------|
| `apps/web` | Next.js App Router + tRPC API |
| `apps/indexer` | Long-running TypeScript indexer worker |
| `packages/contracts` | Soroban Rust contracts |
| `packages/db` | Prisma schema + generated client |
| `packages/sdk` | External SDK for integrators |
| `packages/types` | Shared TypeScript types |
| `packages/ui` | Shared React components |
| `infra` | Local dev infra (Docker Postgres) |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run all apps via Turborepo |
| `pnpm --filter @signet/web dev` | Run web app only (no DB required for demo) |
| `pnpm --filter @signet/web build` | Build web app |
| `pnpm --filter @signet/web typecheck` | Typecheck web app |
| `pnpm db:up` / `db:down` | Start / stop local Postgres |
| `pnpm db:migrate` | Run Prisma migrations |
