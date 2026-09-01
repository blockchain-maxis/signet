# Architecture

This document describes Signet's **real data flows** — what the code actually
does today — and draws a clear line between what is **deployed and serving
traffic**, what is **code-complete but operational-only** (built and tested, but
needs provisioning to go live), and what is still ahead.

For the product thesis see [`README.md`](README.md); for the on-chain trust
model see the contract doc-comment in
[`packages/contracts/identity-registry/src/lib.rs`](packages/contracts/identity-registry/src/lib.rs).

---

## System at a glance

```
                       ┌──────────────────────────────────────────────┐
                       │                apps/web (Next.js)             │
   browser ───────────▶│  /p/{handle}   canonical profile (SSG)        │
                       │  /how-it-works, / (marketing)                 │
                       │  /app/*        dashboard (session-gated)       │
                       │  /api/trpc     profile.* · account.* · health  │
                       │  /api/auth/*   SIWS challenge / verify / logout │
                       └───────┬───────────────────────────┬──────────┘
                               │ reads (DB-first,           │ writes bindings
                               │ static fallback)           │ (claim, signed)
                               ▼                            ▼
                       ┌───────────────┐          ┌──────────────────────┐
                       │  packages/db  │          │  Identity Registry    │
                       │  (PostgreSQL, │          │  Soroban contract     │
                       │   Prisma)     │          │  (on-chain, testnet/  │
                       │               │          │   mainnet)            │
                       └───────▲───────┘          └──────────┬───────────┘
                               │ upserts                     │ emits
                               │ Profile/Wallet/             │ claimed / released
                               │ Contract/Operation/         │ events
                               │ Snapshot                    │
                       ┌───────┴─────────────────────────────▼──────────┐
                       │                apps/indexer (worker)            │
                       │  attestation ← Soroban RPC getEvents            │
                       │  deployment / operations / activity ← Horizon   │
                       └────────────────────────────────────────────────┘
```

Two data flows drive everything below. Both are **code-complete** in this build.

---

## Flow 1 — Identity: `claim → event → attestation → DB`

How a wallet becomes bound to a handle, self-sovereignly, with no trusted oracle.

1. **Connect + sign (client).** The user connects a Stellar wallet through
   Stellar Wallets Kit ([`apps/web/lib/wallet.ts`](apps/web/lib/wallet.ts)).
   `claimHandle(handle, wallet)`
   ([`apps/web/lib/registry.ts`](apps/web/lib/registry.ts)) builds a
   `claim(handle, wallet)` Soroban invocation, simulates + assembles it via
   Soroban RPC, and has the connected wallet sign it. **The signature is the
   proof of ownership** — nothing else is trusted.

2. **On-chain claim (contract).** The signed transaction invokes the Identity
   Registry contract
   ([`packages/contracts/identity-registry`](packages/contracts/identity-registry)).
   `claim` calls `wallet.require_auth()`, so Soroban rejects any claim not
   signed by that wallet's key. It writes the 1:1 `handle ⇄ wallet` binding to
   persistent storage, bumps an O(1) `count`, and **emits an event**:

   ```
   topics = [ symbol("claimed"), string(handle) ],  data = address(wallet)
   ```

   `release` (owner) and `admin_revoke` (moderation) emit `released` the same
   way. Handle enumeration is intentionally off-chain — the event stream is the
   source of truth, keeping per-call storage/cost constant.

3. **Attestation ingest (indexer).** The attestation worker
   ([`apps/indexer/src/workers/attestation.ts`](apps/indexer/src/workers/attestation.ts))
   reads the contract's event stream from Soroban RPC (`getEvents`), resuming
   from a dedicated `IndexerCursor` (id `attestation`). `decodeEvent` turns each
   raw event into `{ kind, handle, wallet }`; `applyAttestation` is idempotent:

   - `claimed` → upsert `Profile` (by handle) + upsert `Wallet`
     (`source = "onchain"`, `isPrimary = true`) linked to it.
   - `released` → delete the `Wallet` binding.

4. **Result.** The database now holds on-chain-verified bindings. On the website
   these take precedence over the curated seed mapping (see *Read path* below).

> The registry is deployed on testnet (see *Deployed vs operational-only*), so
> this flow runs wherever its contract id is configured. Without an id,
> `claimHandle` throws `RegistryNotConfiguredError` and the UI shows an honest
> "Phase 2" state, and the attestation worker no-ops.

---

## Flow 2 — Activity: `wallet → operations → DB`

How a bound wallet's on-chain smart-contract history is materialised for its
profile. The indexer's main loop
([`apps/indexer/src/index.ts`](apps/indexer/src/index.ts)) ticks every
`INDEXER_TICK_INTERVAL_MS` (default 30s) over every `Wallet` row:

- **Deployments** —
  [`workers/deployment.ts`](apps/indexer/src/workers/deployment.ts) pulls each
  wallet's Horizon operations, keeps `invoke_host_function` ops whose function
  is `HostFunctionTypeCreateContract`, resolves the new contract address from
  the transaction's `result_meta_xdr`, and upserts a `Contract` row (idempotent
  on `deployTxHash` / address).
- **Operations** —
  [`workers/operations.ts`](apps/indexer/src/workers/operations.ts) pulls recent
  `invoke_host_function` invocations per wallet and upserts `Operation` rows
  (idempotent on the globally-unique Horizon op id). These back the activity
  list on a profile.
- **Activity snapshots** —
  [`workers/activity.ts`](apps/indexer/src/workers/activity.ts) queries Horizon
  for each tracked contract's transactions and writes a `ContractSnapshot`
  (`txCount24h`, `txCountTotal`, `lastActivity`) with a 5-minute freshness TTL.
- **Cursor** — the highest ledger seen is persisted to `IndexerCursor` (id
  `main`) so restarts resume rather than rescan.

All Horizon calls are spaced by a small rate-limit delay; failures are logged
and skipped without advancing the relevant cursor, so the next tick retries.

---

## Read path — how the web app serves it

`/p/{handle}` is statically generated and reads through a single loader,
[`apps/web/lib/profiles.ts`](apps/web/lib/profiles.ts):

- `getProfile` resolves a handle **database → chain → static manifest**:
  `safeDbProfile` (indexer-synced bindings plus off-chain display fields), then
  `safeChainProfile` (a read-only `resolve(handle)` simulation against the
  Identity Registry over Soroban RPC), then the curated manifest in
  `apps/web/public/data/`. The chain layer is what lets a handle claimed
  on-chain render before — or entirely without — an indexer sync.
  `getOperations` is database-then-Horizon-then-static (`safeDbOperations`,
  `fetchHorizonOperations`), since activity has no single-call on-chain
  equivalent.
- Neither operations layer reads a developer's whole history: the indexer query
  takes the newest `DB_OPERATIONS_PER_WALLET` rows per wallet and the Horizon
  walk stops at `HORIZON_MAX_RECORDS`. `getOperationsResult` therefore returns
  `{ operations, source, truncated, cap }`, and the flag is carried through the
  profile page, the social card, the dashboard, `GET /api/p/{handle}/operations`
  (`meta.truncated`, `meta.cap`) and `profile.byHandle`. A truncated record is
  labelled as partial and its counts render as lower bounds (`412+`), so no
  surface presents a capped list as a complete career record.
- Every layer returns `null` rather than throwing when it isn't provisioned —
  no `DATABASE_URL`, no registry contract id, unreachable RPC — so the demo
  routes work with zero provisioning (preview, prod, offline) and automatically
  upgrade to live data as each dependency comes online. A profile carries the
  layer that resolved it, so `/p/{handle}` can label a curated demo and a
  genuine on-chain binding differently.
- The same data is exposed over a **tRPC API**
  ([`apps/web/lib/server/trpc.ts`](apps/web/lib/server/trpc.ts)):
  `profile.list`, `profile.byHandle`, and `health` are public (per-IP rate
  limited); `account.me` / `account.update` are `protectedProcedure`. The
  external [`@signet/sdk`](packages/sdk) consumes these.
- **Auth** is Sign-In With Stellar: `/api/auth/challenge` → wallet signs →
  `/api/auth/verify` issues a `SameSite=Lax` session cookie
  ([`apps/web/lib/auth.ts`](apps/web/lib/auth.ts)); mutations additionally
  enforce a same-origin check as CSRF defense.
- Sessions are stateless HMACs, so **revocation** is a separate mechanism
  ([`apps/web/lib/session-revocation.ts`](apps/web/lib/session-revocation.ts)):
  a short list, keyed by address or session id, held in the same shared store
  as the sign-in nonces. Each instance caches the whole list and refreshes it
  every ten seconds, so verifying a session stays a local check rather than a
  per-request store read. See [`SECURITY.md`](SECURITY.md) for the levers.

---

## Components

| Path | Role | Runtime |
| --- | --- | --- |
| `apps/web` | Next.js App Router — marketing, profiles, dashboard, tRPC API, SIWS auth | Netlify |
| `apps/indexer` | Long-running worker: attestation + deployment + operations + activity | Container (GHCR image) |
| `packages/contracts/identity-registry` | Soroban `claim`/`release`/`admin_revoke` registry; emits the event stream. Immutable — a defect is recovered by migrating to a new contract, per [`docs/CONTRACT_MIGRATION.md`](docs/CONTRACT_MIGRATION.md) | Stellar network |
| `packages/db` | Prisma schema + client (`Profile`, `Wallet`, `Contract`, `Operation`, `ContractSnapshot`, `IndexerCursor`) | PostgreSQL |
| `packages/sdk` | External SDK over the tRPC API | consumer apps |
| `packages/types` | Shared TypeScript types | — |
| `infra` | Local Postgres (`docker/docker-compose.yml`) + `deploy-contract.sh` | dev / ops |

---

## Deployed vs operational-only

**Deployed & serving traffic today**

- **Web app** — built and hosted on Netlify via git integration
  ([`netlify.toml`](netlify.toml)): landing, `/how-it-works`, `/handles`, and the
  three demo profiles at `/p/{handle}`, rendered from the static manifest using
  **synthetic testnet data**. The tRPC API and SIWS auth surface ship with it.
- **Identity Registry contract** — deployed to Stellar **testnet** on
  **2026-07-09** at `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`
  and `initialize`d. Set `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` (web) and
  `INDEXER_REGISTRY_CONTRACT_ID` (indexer) to that id to activate the claim +
  attestation flow. Not yet deployed to mainnet. Once the web app has that id,
  `getProfile` resolves a handle **database → chain → static manifest**, so a
  handle bound on-chain renders at `/p/{handle}` immediately — no database or
  indexer sync required — while the curated demo profiles keep working.

**Code-complete but operational-only** (built, tested, and containerised —
needs provisioning to go live; this is "Phase 2")

- **Indexer worker** — packaged by [`apps/indexer/Dockerfile`](apps/indexer/Dockerfile)
  and published to GHCR by the opt-in [`deploy.yml`](.github/workflows/deploy.yml)
  (`migrate` → build/push image), gated on the `DEPLOY_ENABLED` repo variable.
  It runs Flow 1 + Flow 2 continuously once pointed at a database.
- **PostgreSQL + migrations** — Prisma schema and migrations exist; a local
  instance is provided by `infra/docker/docker-compose.yml`, and production
  migrations run via `pnpm db:deploy` in the deploy workflow. Everything reading
  the DB degrades gracefully to static data until `DATABASE_URL` is set.

**Config flags that flip operational-only → live**

| Variable | Enables |
| --- | --- |
| `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` / `INDEXER_REGISTRY_CONTRACT_ID` | On-chain claims + attestation ingest (Flow 1) |
| `DATABASE_URL` | DB-backed reads and the indexer's write path (Flow 2) |
| `DEPLOY_ENABLED` (repo var) + `DATABASE_URL` (secret) | Continuous delivery: prod migrations + indexer image publish |

Full declarations and defaults live in [`.env.example`](.env.example). Every
variable there is listed below so docs and the example file stay in lockstep
(enforced by the `docs` CI job).

| Variable | Consumed by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | web, indexer, db | Optional for demo `/p` routes; required for indexer |
| `STELLAR_NETWORK` | server / tooling | `testnet` or `mainnet` |
| `STELLAR_HORIZON_URL` | server / indexer | Horizon base URL |
| `SOROBAN_RPC_URL` | server, `/handles` directory | Soroban RPC; directory also accepts a dedicated override |
| `NEXT_PUBLIC_APP_URL` | web | Public site origin |
| `NEXT_PUBLIC_ROOT_DOMAIN` | web | Root domain for routing |
| `SIGNET_AUTH_SECRET` | web (SIWS) | ≥16 chars in production |
| `SIGNET_SESSIONS_VALID_AFTER` | web (SIWS) | Unix ms; bump to revoke all sessions (per-address and per-session revocation is in `session-revocation.ts`) |
| `NEXT_PUBLIC_STELLAR_NETWORK` | web (wallet kit) | Client network label |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | web (claims) | Browser-side RPC |
| `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` | web, indexer fallback | Empty → claim UI shows Phase 2 |
| `INDEXER_REGISTRY_CONTRACT_ID` | indexer attestation | Falls back to `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` |
| `INDEXER_EVENT_WINDOW_LEDGERS` | indexer attestation | First-run event lookback |
| `INDEXER_TICK_INTERVAL_MS` | indexer loop | Default `30000` |
| `REGISTRY_CONTRACT_ID` | web `/handles` | Falls back to `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` |
| `REGISTRY_EVENT_WINDOW_LEDGERS` | web `/handles` | Per-request event lookback, used only when no `DATABASE_URL` is configured |

---

## CI gates

[`ci.yml`](.github/workflows/ci.yml) runs on every push/PR:

- **web** — `lint` · `typecheck` · `test` · `build`
- **contracts** — `cargo test` + `cargo build --target wasm32v1-none --release`
- **security** — `pnpm audit` + `cargo audit` (advisory)
- **docs** — relative link/anchor check, env-var lockstep with `.env.example`,
  and `pnpm`/`cargo` script names cited in markdown (`scripts/check-docs.mjs`)

Deployment ([`deploy.yml`](.github/workflows/deploy.yml)) is separate and opt-in,
so forks and un-provisioned clones never attempt to deploy.
