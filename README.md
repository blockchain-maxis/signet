# Signet

Signet is a verifiable developer career record built on Stellar/Soroban. Developers link their deployment wallets to a profile; on-chain attestations bind wallet → identity; an indexer pulls every contract they've deployed along with its activity. Public profiles become the canonical record of a developer's smart-contract career.

## Status

| Component | Network / host | State |
|-----------|----------------|-------|
| **Identity Registry** contract | Stellar **testnet** | **Deployed 2026-07-09** — `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`, wasm executable, `initialize`d |
| **Identity Registry** contract | Stellar **mainnet** | Not deployed |
| **Web app** (`apps/web`) | Netlify ([`netlify.toml`](netlify.toml)) | Deployed — landing, `/how-it-works`, `/handles`, tRPC API, SIWS auth, demo profiles |
| **Indexer** (`apps/indexer`) | GHCR image, opt-in [`deploy.yml`](.github/workflows/deploy.yml) | Code-complete, not provisioned — needs a Postgres to point at |
| **PostgreSQL** (`packages/db`) | — | Prisma schema + migrations committed; no hosted instance |

Point the app at the deployed registry with:

```bash
NEXT_PUBLIC_IDENTITY_REGISTRY_ID=CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
```

**What the deployment does *not* change:** the three profiles at `/p/{handle}`
still render the curated **synthetic testnet manifest** in
`apps/web/public/data/` — a live registry does not make that data real activity.
`/handles` is the one surface that reads live on-chain state. It discovers candidate
handles from the registry's `claimed`/`released` event stream, then confirms each one
with a `resolve` call before listing it as bound, and takes its headline number from
the contract's own `count()`. Curated demo handles that do not resolve are shown in a
separate section labelled *not bound on-chain* and are never counted — with no contract
id configured, the page says so rather than presenting the manifest as registry state.

## Live demo

**<https://signet-web-pearl.vercel.app>** — deployed from `main`.

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
| `/handles` | Handle directory — bindings confirmed against the registry via `resolve`, counted by its own `count()`; demo personas listed separately and labelled *not bound on-chain* |
| `/how-it-works` | How Signet works + what's coming |
| [`docs/DEMO_DATA.md`](docs/DEMO_DATA.md) | Demo fixture provenance, schema, and honesty policy |

## What's working in this build

- **Landing page** — polished marketing page with animated sections and a live "See it in action" demos block linking to the 3 profiles
- **Demo profiles at `/p/{handle}`** — server-rendered (SSG) profile pages reading synthetic testnet operation data from `apps/web/public/data/{handle}.json`; clearly labelled as demo data
- **How it works page** — explains the thesis, what's live, and what's coming
- **Middleware routing** — `/p/` and `/how-it-works` pass through; handles validated; legacy `/profile/` redirects to `/p/`
- **Production data path** — the same UI renders real Horizon API data once the indexer + a Postgres instance are provisioned (`safeDbProfile` already wires the DB-with-static fallback)

## Also implemented

- **On-chain Identity Registry — deployed to testnet** — a real Soroban contract (`packages/contracts/identity-registry`) binds a wallet to a handle via a signed `claim`; ownership is enforced by `require_auth`. Live at `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN` since 2026-07-09 (see [Status](#status)). 24 unit tests, builds to wasm.
- **Wallet connect + claim flow — live** — `Connect wallet` / `Claim your handle` use Stellar Wallets Kit and submit a real on-chain `claim` against the deployed registry (`apps/web/lib/{wallet,registry}.ts`) whenever `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` is set. With no contract id configured, `claimHandle` throws `RegistryNotConfiguredError` and the UI shows an honest "Phase 2" message rather than a broken button.
- **Public handle directory** — `/handles` rebuilds the currently-bound set from the registry's `claimed`/`released` event stream over Soroban RPC, with no database in the path (`apps/web/lib/directory.ts`).
- **Real API + SDK** — tRPC `profile.byHandle` / `profile.list` / `health`; `@signet/sdk` fetches them. Both covered by tests.
- **CI gates** lint · typecheck · test · build, plus a Rust contract job.

## What's coming next (Phase 2)

- **Mainnet deploy** of the Identity Registry (testnet is live — see [Status](#status)), plus a contract audit before it.
- **Run the indexer** against a Postgres instance to populate full deployment/activity history; `/p` already has a DB-with-static-fallback loader (`safeDbProfile`).
- **Self-sovereign bindings** replace the curated `DEMO_PROFILES` mapping as claims land on the deployed registry.
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
Both flows are code-complete; the sketch below marks which pieces are running.

```
browser ──▶  apps/web (Next.js)                                   [DEPLOYED]
             /p/{handle} · /handles · /how-it-works · /api/trpc · /api/auth
                  │                                    │
    reads profile │                                    │ submits signed claim
    (DB first,    │                                    ▼
     static       │            Identity Registry (Soroban)  [DEPLOYED 2026-07-09]
     fallback)    │            testnet · CASFJHI5…AG7FUJRCN
                  │                                    │ emits claimed / released
                  │                                    ▼
                  │            apps/indexer (worker)        [OPERATIONAL-ONLY]
                  │            attestation ← Soroban RPC getEvents
                  │            deployment · operations · activity ← Horizon
                  │                                    │ upserts
                  ▼                                    ▼
             packages/db (PostgreSQL)                       [OPERATIONAL-ONLY]
             Profile · Wallet · Contract · Operation · ContractSnapshot
```

`/handles` reads the registry's event stream over Soroban RPC directly — the
indexer's Postgres sync is an accelerant for it, not a dependency.

**Deployed & serving traffic**

- `apps/web` on Netlify — landing, `/how-it-works`, `/handles`, demo profiles (synthetic manifest), tRPC API, SIWS auth
- `packages/contracts/identity-registry` — Soroban contract on Stellar **testnet**, 24 `cargo test` unit tests, builds to wasm

**Operational-only** — built and tested, needs provisioning to go live

- `apps/indexer` — attestation + deployment + operations + activity workers; needs `DATABASE_URL`
- `packages/db` — Prisma schema + committed migrations; no hosted Postgres yet
- `packages/sdk` — external SDK over the tRPC API; in-tree, not yet published to npm

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
| `cli` | `signet` CLI (Go) — links wallets, manages keys, talks to a Signet deployment |
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
| `pnpm test` | All TypeScript tests via Turborepo |
| `cargo test` (in `packages/contracts`) | Identity Registry unit tests |
| `go build ./...` / `go test ./...` (in `cli`) | Build / test the `signet` CLI |

## Tests

| Suite | Count |
|-------|-------|
| `pnpm test` | **208** — `@signet/web` 137 · `@signet/indexer` 36 · `@signet/sdk` 26 · `@signet/types` 9 (`db` has no tests yet) |
| `cargo test` | **30** — `packages/contracts/identity-registry` |

Both are CI gates ([`ci.yml`](.github/workflows/ci.yml)), alongside `lint`,
`typecheck`, `build` and the wasm contract build.

## License

Signet is licensed under the Apache License 2.0 — see [`LICENSE`](LICENSE) for the
full text. This covers every workspace package (`@signet/sdk`, `@signet/types`,
`@signet/db`, `@signet/web`, `@signet/indexer`) and the Soroban
`identity-registry` contract.
