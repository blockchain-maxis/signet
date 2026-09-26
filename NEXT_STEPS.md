# Next steps

## Done in the Phase-1 hardening pass

1. **Identity Registry Soroban contract — implemented.**
   `packages/contracts/identity-registry/src/lib.rs` now binds a wallet to a
   handle with `claim`/`release`/`admin_revoke` + read methods, enforces
   ownership via `require_auth`, validates handles, and emits events. Covered by
   13 unit tests (`cargo test`) and builds to a ~11 KB wasm.
2. **Wallet connect — implemented.** `apps/web/lib/wallet.ts` configures Stellar
   Wallets Kit (network from `NEXT_PUBLIC_STELLAR_NETWORK`), with
   connect/disconnect/persist/sign helpers, wired into the hero via
   `ConnectWallet`.
3. **On-chain claim flow — implemented (config-gated).** `apps/web/lib/registry.ts`
   builds, simulates, signs and submits a `claim` invocation. Until
   `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` is set it surfaces an honest "Phase 2"
   message instead of failing.
4. **Routing consolidated.** One canonical profile surface (`/p/{handle}`); the
   legacy Prisma route now redirects, so no request path depends on Postgres.
5. **tRPC + SDK are real.** `profile.byHandle` / `profile.list` / `health`
   procedures; `@signet/sdk` fetches them over HTTP. Both covered by tests.
6. **CI gates lint · typecheck · test · build, plus a Rust contract job.**

## Remaining work, in priority order

1. **Deploy the Identity Registry** to testnet then mainnet; set
   `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` and initialize the admin. This flips the
   claim flow live.
2. **Provision Postgres + run the indexer** (`apps/indexer`) against the
   on-chain-bound wallets to populate full deployment/activity history; `/p`
   already reads the DB first, falling back to the chain (`safeDbProfile`).
3. **Build out the dashboard** (`apps/web/app/(dashboard)`) behind wallet auth:
   profile editing, wallet linking, settings.
4. **"Verified by Signet" badge** — a small embeddable snippet powered by
   `@signet/sdk`.

### Remaining work needs external resources (you trigger; scaffolding is ready)

The codebase is deploy-ready. What's left to reach a live 8/10 MVP is operational:

1. **Deploy the contract** — `./infra/deploy-contract.sh` (builds, deploys,
   `initialize`s), then set `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` +
   `INDEXER_REGISTRY_CONTRACT_ID`.
2. **Provision Postgres + run the indexer** — `apps/indexer/Dockerfile` runs
   `migrate deploy` then starts the worker. Point it at a managed Postgres.
3. **Wire a monitoring/error-tracking provider** to `/health` + the structured
   logs (Sentry/OTel keys).
4. **Commission a contract audit** before mainnet.

### Done (in-tree, this round)

- **Attestation worker** — reads `claimed`/`released` events → DB (5 tests).
- **DB migration** — initial migration committed; `pnpm db:deploy` applies it.
- **Observability** — `/health` probe, structured JSON logger, per-request ids,
  per-ip rate limiting on the API.
- **Wallet session auth (SIWS)** — challenge/verify/logout routes + HMAC session;
  the dashboard is gated behind a real sign-in wall (`lib/auth.ts`, 5 tests).
- **`/p` is DB-preferred** with a chain + Horizon fallback (`safeDbProfile`).
- **Reputation signal** + **OG images** on profiles.
- **Tests** — 29 TS (web 20 · sdk 4 · indexer 5) + 14 cargo; CI gates all.
- **Deploy scaffolding** — indexer `Dockerfile`, `infra/deploy-contract.sh`.
- **e2e** — Playwright config + smoke specs (`test:e2e`); enable with
  `pnpm add -D @playwright/test && pnpm exec playwright install`.

## Notes / deviations

- **Route groups vs. the spec tree.** Next.js route groups are invisible in the
  URL, so each non-marketing group's pages live under a real path segment
  (`(dashboard)/app/*`, `(docs)/docs/*`). Marketing keeps `/`.
- **Node 22+** is required (the test runner uses `node --experimental-strip-types
  --test`, so TS tests run with zero extra dependencies).
- `@signet/db` re-exports `@prisma/client`; the client is generated on
  `postinstall` / `pnpm db:generate`. The web app no longer hard-depends on it
  at request time.
