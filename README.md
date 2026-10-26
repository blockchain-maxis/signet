# Signet

Signet is a verifiable developer career record built on Stellar/Soroban. Developers link their deployment wallets to a profile; on-chain attestations bind wallet → identity; an indexer pulls every contract they've deployed along with its activity. Public profiles become the canonical record of a developer's smart-contract career.

## Status

| Component | Network / host | State |
|-----------|----------------|-------|
| **Identity Registry** contract | Stellar **testnet** | **Deployed 2026-07-09** — `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`, wasm executable, `initialize`d |
| **Identity Registry** contract | Stellar **mainnet** | Not deployed |
| **Web app** (`apps/web`) | Vercel | Deployed — landing, `/how-it-works`, `/handles`, `/p/{handle}` profiles and contract pages, `/docs` and `/docs/api`, the public `/api/v1`, SIWS auth |
| **Indexer** (`apps/indexer`) | GHCR image, opt-in [`deploy.yml`](.github/workflows/deploy.yml) | Code-complete, not provisioned — needs a Postgres to point at |
| **PostgreSQL** (`packages/db`) | — | Prisma schema + migrations committed; no hosted instance |
| **CLI** (`signet`, `cli/`) | npm (not yet) | Built: `link`, `status`, `whoami`, and `signet dev`, the local contract sandbox ([`docs/SANDBOX.md`](docs/SANDBOX.md)). Not published to npm yet; build it from source per [`docs/CLI.md`](docs/CLI.md) |

Point the app at the deployed registry with:

```bash
NEXT_PUBLIC_IDENTITY_REGISTRY_ID=CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
```

**Only real data is served.** There are no demo or fixture profiles: `/p/{handle}`
renders a handle only when the indexer's database or a live `resolve` against the
registry knows it, with activity from the database or Horizon — anything else is a 404.
`/handles` discovers candidate handles from the indexer's database (or, without one,
the registry's `claimed`/`released` event stream), confirms each one with a `resolve`
call before listing it, and takes its headline number from the contract's own
`count()`. With no contract id configured, the page says so and lists nothing.

## Live site

**<https://signet-web-pearl.vercel.app>** — deployed from `main`.

| URL | Description |
|-----|-------------|
| `/` | Landing page |
| `/handles` | Handle directory — bindings confirmed against the registry via `resolve`, counted by its own `count()` |
| `/p/{handle}` | Profile for any handle bound on the registry (404 otherwise) |
| `/p/{handle}/contract/{address}` | A contract one of the handle's wallets deployed (404 otherwise): interface, generated docs, diagram, activity |
| `/docs/api` | The public API reference, generated from the OpenAPI document |
| `/how-it-works` | How Signet works + what's coming |
| [`docs/CLI.md`](docs/CLI.md) | Terminal linking: install, the link flow and what each step proves, CI usage, exit codes, troubleshooting |
| [`docs/SANDBOX.md`](docs/SANDBOX.md) | The contract sandbox: run a deployed contract locally on a fork, and `signet dev` to compare a new build with it before shipping |

## Contract pages

Each contract a profile's wallets deployed gets a page at `/p/{handle}/contract/{address}`:
its interface read from the deployed WASM, generated reference docs, a diagram of its
functions and types, its upgrade history and its activity. The page exists only under the
handle that deployed the contract, by the indexer's record of deployments (or, on a
deployment without one, a walk of the wallet's Horizon history). For any other handle it is
a 404, so nobody can put your contract under their name. It does **not** attribute contracts
created by a factory contract, without an indexer it searches only the most recent 400
operations of each wallet, and upgrade history starts when indexing began. Contract code is
never executed by Signet's servers: running a contract is `signet dev`, on your machine.

## API

`/api/v1` is the public, read-only API: profiles, wallets, contracts and their attribution,
operations, the reverse wallet lookup, contract specs, registry stats, health and a
"Verified by Signet" badge. The machine-readable document is served at
`/api/v1/openapi.json` and committed as [`docs/api/openapi-v1.json`](docs/api/openapi-v1.json);
the rules are [`docs/API_V1.md`](docs/API_V1.md), the reference pages are `/docs/api`, and
[`@signet/sdk`](packages/sdk) is a typed client for it (not on npm yet).
[`examples/grant-portal`](examples/grant-portal) shows an integration end to end.

## What's working in this build

- **Landing page** — polished marketing page with animated sections; its illustrative mockups are labelled as such, and its CTAs point at the real `/handles` directory
- **Profiles at `/p/{handle}`** — server-rendered profile pages resolved database → chain, with activity from the database or Horizon; an unknown handle is a 404
- **How it works page** — explains the thesis, what's live, and what's coming
- **Middleware routing** — `/p/` and `/how-it-works` pass through; handles validated; legacy `/profile/` redirects to `/p/`
- **Production data path** — with a Postgres instance and the indexer provisioned, the same UI reads indexed rows first (`safeDbProfile`), falling back to the chain and Horizon

## Also implemented

- **On-chain Identity Registry — deployed to testnet** — a real Soroban contract (`packages/contracts/identity-registry`) binds a wallet to a handle via a signed `claim`; ownership is enforced by `require_auth`. Live at `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN` since 2026-07-09 (see [Status](#status)). 24 unit tests, builds to wasm.
- **Wallet connect + claim flow — live** — `Connect wallet` / `Claim your handle` use Stellar Wallets Kit and submit a real on-chain `claim` against the deployed registry (`apps/web/lib/{wallet,registry}.ts`) whenever `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` is set. With no contract id configured, `claimHandle` throws `RegistryNotConfiguredError` and the UI says this deployment is not configured against a registry, rather than showing a broken button.
- **Public handle directory** — `/handles` discovers candidates from the indexer's database or, without one, the registry's `claimed`/`released` event stream over Soroban RPC, and confirms each with `resolve` (`apps/web/lib/directory.ts`).
- **Real API + SDK** — a versioned REST API under `/api/v1` ([docs/API_V1.md](docs/API_V1.md)); `@signet/sdk` reads it with typed errors. Both covered by tests.
- **CI gates** lint · typecheck · test · build, plus a Rust contract job.

## What's coming next (Phase 2)

- **Mainnet deploy** of the Identity Registry (testnet is live — see [Status](#status)), plus a contract audit before it.
- **Terminal deploy-wallet linking, published** — `signet link` binds the wallet you run `stellar contract deploy` from to your claimed handle, proving control of the key from your terminal. This is the step that turns a claimed handle into an indexed profile: a handle claimed with a browser wallet points at an address that has usually deployed nothing, so the profile renders empty until a deploy wallet is linked. The command is built (documented in [`docs/CLI.md`](docs/CLI.md)); `npx @signet/cli link` works once the package is published.
- **Run the indexer** against a Postgres instance to populate full deployment/activity history; `/p` already reads the database first (`safeDbProfile`). Once a deploy wallet is linked, the indexer attributes every contract it has deployed and invoked to that profile.
- **Developer dashboard** (`/app/*`) — currently an honest read-only preview pending wallet auth.
- **Reputation scoring** — attestations, TVL tracking, incident records.
- **Publishing the CLI and SDK** — the `signet` CLI (pairing, status and the
  `signet dev` sandbox, which bridges to the Rust `signet-simulator` as a
  subprocess, see [`docs/CLI_RUST_BRIDGE.md`](docs/CLI_RUST_BRIDGE.md)) and
  `@signet/sdk` are built and tested in this repository but not yet on npm.

## Run locally

```bash
git clone <repo> signet && cd signet
pnpm install

# Run just the web app (no database needed)
pnpm --filter @signet/web dev
```

Visit `http://localhost:3000` for the landing page. Set
`NEXT_PUBLIC_IDENTITY_REGISTRY_ID` (see [Status](#status)) and visit
`http://localhost:3000/handles` to browse the handles bound on the registry.

> **Requires Node 22+.** Fonts (`IBM Plex Sans`/`Mono`) load via a browser-side `@import` in `globals.css` (not `next/font`), so the build never blocks on font downloads.

First-run failures (stellar CLI passphrase bug, Friendbot funding, missing
`wasm32v1-none`, no `DATABASE_URL`, the not-configured claim message, indexer without a
registry id): see [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

## Self-host / deploy

**See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** for a clone-to-running guide:
prerequisites, deploy key + Friendbot, wasm build, `infra/deploy-contract.sh`,
`initialize(admin)`, Vercel production env
(including `SIGNET_AUTH_SECRET`), verification checklist, and rollback.

## Roadmap and funding

**See [`PROPOSAL.md`](PROPOSAL.md)** for the grant proposal: the problem
statement, an itemized budget, dated milestones through 2027-04-30, and a
fix-log of resolved issues with the tests that keep them closed.

Design notes for roadmap items, written before the code so the shape is settled
first:

| Note | Item |
|------|------|
| [`docs/CONTRACT_DOCS_DESIGN.md`](docs/CONTRACT_DOCS_DESIGN.md) | Generating contract reference documentation from the deployed WASM's `contractspecv0` section |
| [`docs/CONTRACT_SANDBOX_DESIGN.md`](docs/CONTRACT_SANDBOX_DESIGN.md) | Running a deployed contract's functions from a profile — RPC simulation first, embedded host second |
| [`docs/CONTRACT_VISUALISER_DESIGN.md`](docs/CONTRACT_VISUALISER_DESIGN.md) | Rendering a deployed contract's call surface, type graph, and (later) call graph as a diagram a non-developer can read |
| [`docs/API_V1.md`](docs/API_V1.md) | The public `/api/v1` contract: versioning, envelope and error codes, pagination, CORS, caching and rate limits |

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
     chain        │            Identity Registry (Soroban)  [DEPLOYED 2026-07-09]
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

- `apps/web` on Vercel — landing, `/how-it-works`, `/handles`, `/p/{handle}` profiles, tRPC API, SIWS auth
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
| `pnpm --filter @signet/web dev` | Run web app only (no DB required) |
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

## Releases and changelog

- **[`CHANGELOG.md`](CHANGELOG.md)** — Record of notable changes, version history, and deployed contract addresses.
- **[`docs/RELEASING.md`](docs/RELEASING.md)** — Release procedure, Semantic Versioning policy, and tagging conventions.

## License

Signet is licensed under the Apache License 2.0 — see [`LICENSE`](LICENSE) for the
full text. This covers every workspace package (`@signet/sdk`, `@signet/types`,
`@signet/db`, `@signet/web`, `@signet/indexer`) and the Soroban
`identity-registry` contract.
