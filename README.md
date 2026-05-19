# Signet

Signet is a verifiable developer career record built on Stellar/Soroban. Developers link their deployment wallets to a profile; on-chain attestations bind wallet → identity; an indexer pulls every contract they've deployed along with its activity. Public profiles become the canonical record of a developer's smart-contract career.

## Live demo

| URL | Description |
|-----|-------------|
| `/` | Landing page with "See it in action" section |
| `/p/aquawolf` | Demo profile — Blend Protocol collateral ops |
| `/p/sorobuilder` | Demo profile — Soroswap DEX swaps |
| `/p/stellardev` | Demo profile — USDC token transfers |
| `/how-it-works` | How Signet works + what's coming |

## What's working in this build

- **Landing page** — polished marketing page with animated sections and a live "See it in action" demos block linking to the 3 profiles
- **Demo profiles at `/p/{handle}`** — server-rendered profile pages reading real Soroban operation data from `apps/web/public/data/{handle}.json`; each operation links to Stellar Expert for independent verification
- **How it works page** — explains the thesis, what's live, and what's coming
- **Middleware routing** — `/p/` and `/how-it-works` pass through correctly; existing subdomain routing logic preserved
- **Real on-chain data** — all operation data comes from the Stellar Horizon public API, fetched live and stored as static JSON; function names decoded from XDR

## What's stubbed or coming next

- **Handle-to-wallet mapping** — hardcoded in `profiles.json`; no wallet-connect or on-chain attestation yet
- **No on-chain identity registry** — Phase 2 will write a Soroban contract that binds profile → wallet cryptographically
- **No indexer** — operation data was fetched once and stored statically; the `apps/indexer/` worker is scaffolded but not running
- **Dashboard routes** (`/app`, `/app/wallets`, etc.) — scaffolded but require a database connection (Prisma) and are not functional
- **`/profile/{handle}` route** — uses Prisma, will 404 or error without a running database; use `/p/{handle}` for the demo
- **Reputation scoring** — op counts are raw; no attestations, TVL tracking, or incident records
- **No authentication** — claim flow ("Sign in with your wallet") is a stub

## Run locally

```bash
git clone <repo> signet && cd signet
pnpm install

# Run just the web app (no database needed for the demo routes)
pnpm --filter @signet/web dev
```

Visit `http://localhost:3000` for the landing page.
Visit `http://localhost:3000/p/aquawolf` for the first demo profile.

> **Note:** Google Fonts (`IBM Plex Sans`, `IBM Plex Mono`) are loaded via `next/font/google`. In environments without internet access, the build will log font fetch errors but continue — the pages render with system font fallbacks.

## Architecture (planned)

```
┌─────────────────────────────────────────────────────┐
│                    apps/web (Next.js)                │
│  /p/{handle}   — static JSON → profile render        │
│  /profile/{handle} — Prisma → profile render (Phase2)│
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

Future:
  packages/contracts/identity-registry  — Soroban contract
  packages/sdk                          — External SDK
```

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
