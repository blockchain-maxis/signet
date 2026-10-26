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
   browser ───────────▶│  /p/{handle}   canonical profile (dynamic)    │
                       │  /p/{handle}/contract/{address}  contract page│
                       │  /how-it-works, /docs, /docs/api, / (marketing)│
                       │  /app/*        dashboard (session-gated)       │
                       │  /api/trpc     the app's own data layer        │
                       │  /api/v1       public read-only API (+ SDK)    │
                       │  /api/auth/*   SIWS challenge / verify / logout │
                       └───────┬───────────────────────────┬──────────┘
                               │ reads (DB-first,           │ writes bindings
                               │ chain fallback)            │ (claim, signed)
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
                               │ Snapshot/WasmVersion        │
                       ┌───────┴─────────────────────────────▼──────────┐
                       │                apps/indexer (worker)            │
                       │  attestation ← Soroban RPC getEvents            │
                       │  deployment / operations / activity ← Horizon   │
                       │  executable-refresh / invocations ← Soroban RPC │
                       └────────────────────────────────────────────────┘

   developer machine only (no Signet server involved):
   ┌───────────────────────────┐  stdio JSON  ┌──────────────────────────┐
   │ cli (Go): signet link,    │─────────────▶│ sandbox/simulator (Rust): │
   │ status, dev, sandbox      │◀─────────────│ forked ledger, real host, │
   └─────────────┬─────────────┘              │ replays and diffs         │
                 │ ledger entries               └──────────────────────────┘
                 ▼
          Soroban RPC (read-only)
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

4. **Result.** The database now holds on-chain-verified bindings, which the
   website reads first (see *Read path* below).

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

`/p/{handle}` is rendered per request and reads through a single loader,
[`apps/web/lib/profiles.ts`](apps/web/lib/profiles.ts):

- `getProfile` resolves a handle **database → chain**: `safeDbProfile`
  (indexer-synced bindings plus off-chain display fields), then
  `safeChainProfile` (a read-only `resolve(handle)` simulation against the
  Identity Registry over Soroban RPC). The chain layer is what lets a handle
  claimed on-chain render before — or entirely without — an indexer sync.
  `getOperations` is database-then-Horizon (`safeDbOperations`,
  `fetchHorizonOperations`), since activity has no single-call on-chain
  equivalent. There is no static or fixture layer: only real data is served.
- Neither operations layer reads a developer's whole history: the indexer query
  takes the newest `DB_OPERATIONS_PER_WALLET` rows per wallet and the Horizon
  walk stops at `HORIZON_MAX_RECORDS`. `getOperationsResult` therefore returns
  `{ operations, source, truncated, cap }`, and the flag is carried through the
  profile page, the social card, the dashboard, `GET /api/p/{handle}/operations`
  (`meta.truncated`, `meta.cap`) and `profile.byHandle`. A truncated record is
  labelled as partial and its counts render as lower bounds (`412+`), so no
  surface presents a capped list as a complete career record.
- Every layer returns `null` rather than throwing when it isn't provisioned —
  no `DATABASE_URL`, no registry contract id, unreachable RPC — so a deployment
  with nothing provisioned still serves every page: `/p/{handle}` is a clean
  404 and `/handles` says no registry is configured, rather than a 500. Each
  surface upgrades to live data as its dependency comes online. A profile
  carries the layer that resolved it (`database` or `chain`).
- The same data is exposed over a **tRPC API**
  ([`apps/web/lib/server/trpc.ts`](apps/web/lib/server/trpc.ts)):
  `profile.list`, `profile.byHandle`, and `health` are public (per-IP rate
  limited); `account.me` / `account.update` are `protectedProcedure`. The
  external [`@signet/sdk`](packages/sdk) consumes these. tRPC is the web app's
  own data layer, not a public contract — integrators read `/api/v1`
  (see [`docs/API_V1.md`](docs/API_V1.md)).
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
- **CLI device pairing** binds a CLI-held deploy account to a browser-owned
  handle without either side seeing the other's credentials
  ([`apps/web/lib/server/pairing.ts`](apps/web/lib/server/pairing.ts)):
  `POST /api/cli/pair/start` mints a `PairingState`; `POST
  /api/cli/pair/approve` (browser, session-authenticated) records which
  profile is pairing; `POST /api/cli/pair/complete` (CLI, authenticated by a
  signed SEP-10 challenge for the deploy account) writes the `Wallet` row.
  Both proofs are required — neither side's bare assertion is trusted — and
  the signed challenge is spent via the same nonce store as sign-in, so a
  pairing cannot be replayed.

---

## Flow 3 — Contract page: `/p/{handle}/contract/{address}`

A contract gets its own page only under the handle whose wallet deployed it.
The design is [`docs/CONTRACT_DOCS_DESIGN.md`](docs/CONTRACT_DOCS_DESIGN.md);
this is what the code does.

1. **Attribution** ([`apps/web/lib/contract-attribution.ts`](apps/web/lib/contract-attribution.ts),
   `attributeContract`). The database answers first: a `Contract` row for the
   address, on the configured network, owned by any of the handle's wallets. A
   reachable database with no such row is a **404**, and does not fall through.
   Only with no database (unset or unreachable) does Horizon answer: each of
   the handle's `G…` wallets has its operations walked for
   `HostFunctionTypeCreateContract`, and the created address derived from the
   salt or decoded from the transaction's result meta (v3 and v4). Anything
   else is a 404, and a lookup that could not be made is the error state, not
   a 404. Limits, stated on the page and in `/how-it-works`:
   - contracts created by a **factory contract** are not attributed;
   - without a database the walk stops at `HORIZON_MAX_RECORDS` (400)
     operations, so an older deployment reads as not attributed;
   - contract-controlled (`C…`) wallets are covered only through the database.

   `GET /api/v1/profiles/{handle}/contracts/{address}` serves the same verdict,
   with byte-identical 404s for "someone else's" and "no such contract".
2. **The header's WASM hash** ([`apps/web/lib/contract-header.ts`](apps/web/lib/contract-header.ts)).
   The live instance read (`fetchWasmHash`) wins when it answers, because an
   upgrade changes the hash without changing the address; otherwise the
   indexed `Contract.wasmHash`, labelled as such; an archived instance and
   "neither" are labelled too. The field is never blank.
3. **Upgrade history.** The indexer's `deployment` and `executable-refresh`
   workers ([`apps/indexer/src/workers/executable-refresh.ts`](apps/indexer/src/workers/executable-refresh.ts))
   record each WASM hash they see as a `ContractWasmVersion` row, with the
   ledger at which they noticed it, not the upgrade's own. History therefore
   starts when indexing began, and the Changes tab
   ([`apps/web/lib/contract-changelog.ts`](apps/web/lib/contract-changelog.ts))
   says so.
4. **Caches** ([`apps/web/lib/server/contract-cache.ts`](apps/web/lib/server/contract-cache.ts)).
   The HTML is never cached (the CSP nonce makes every route dynamic). Per
   request, React `cache()` shares the attribution verdict, the live instance
   read and the newest activity snapshot. Across requests:

   | What | Key | Lifetime |
   | --- | --- | --- |
   | Interface (spec) | `wasmHash` | forever (a hash names its bytes) |
   | Attribution, a match | `contract:{address}` + handle | 300 s, tag-revalidatable |
   | Attribution, a miss | address + handle + network | 30 s, in process |
   | Live instance WASM hash | address + network | 60 s |
   | Horizon fallback fetches | the URL | 300 s |

   An outage or a failed read is never cached.

The diagram tab draws from the same spec through
[`packages/visualiser`](packages/visualiser) (design:
[`docs/CONTRACT_VISUALISER_DESIGN.md`](docs/CONTRACT_VISUALISER_DESIGN.md)).

---

## The shared spec reader

Every surface that reads a contract's interface goes through one package,
[`packages/spec`](packages/spec) (`@signet/spec`): it fetches the WASM, reads
the `contractspecv0` custom section and decodes it into `SpecJson` v1. It
renders nothing and executes nothing.

- **Consumers:** the contract page's generated docs and Changes tab
  (`apps/web/lib/docs/*`, `contract-changelog.ts`), the diagram
  (`packages/visualiser`), the API's spec endpoints
  (`apps/web/lib/api/v1/contract-spec.ts`), and the Go CLI and sandbox, whose
  simulator emits the same `SpecJson` v1 from `spec_extract`
  ([`sandbox/simulator/src/spec_verbs.rs`](sandbox/simulator/src/spec_verbs.rs)),
  validated against the same schema.
- **Cache key:** the WASM hash. A hash names its bytes, so a decoded spec never
  goes stale: memory LRU, then the `ContractSpec` table.
- **Limits** (#440), so hostile input cannot pin the parser: `MAX_WASM_BYTES`
  (256 KB), `MAX_WASM_SECTIONS` and `MAX_SPEC_ENTRIES` (1,024 each), in
  [`packages/spec/src/parse.ts`](packages/spec/src/parse.ts) and
  [`wasm-sections.ts`](packages/spec/src/wasm-sections.ts).

---

## Local sandbox: `signet dev`

Contract code is executed **only on the developer's machine**. No Signet
server runs a contract, simulates one, or receives the developer's source.

- [`cli`](cli) (Go) is the developer's entry point: `signet dev` builds the
  crate, forks the deployed contract's ledger state from a Soroban RPC, and on
  each change replays saved and real transactions against the deployed WASM
  (A) and the new build (B), then reports the differences.
- [`sandbox/simulator`](sandbox/simulator) (Rust, the `signet-simulator`
  binary) runs the real Soroban host over that forked ledger. It speaks a
  versioned JSON protocol over stdio
  ([`sandbox/protocol`](sandbox/protocol)); the CLI spawns it and answers its
  ledger fetches. It also diffs results and classifies differences
  (breaking, behavioural, cost).
- What is forked: the ledger entries the calls read, fetched lazily and kept
  in a local cache. What is replayed: calls saved in `signet.dev.toml` and real
  transactions collected from the network. Bundles record both for offline
  runs (`signet dev --ci --bundle`).

The user guide is [`docs/SANDBOX.md`](docs/SANDBOX.md); the design is
[`docs/CONTRACT_SANDBOX_DESIGN.md`](docs/CONTRACT_SANDBOX_DESIGN.md) and the
CLI-to-Rust boundary [`docs/CLI_RUST_BRIDGE.md`](docs/CLI_RUST_BRIDGE.md).

---

## Public API v1

The public, read-only HTTP contract is `/api/v1`
([`apps/web/app/api/v1`](apps/web/app/api/v1), shared plumbing in
[`apps/web/lib/api/v1/http.ts`](apps/web/lib/api/v1/http.ts)): profiles,
wallets, contracts and their attribution, operations, the reverse wallet
lookup, specs, registry stats, health and the badge.

- **Relation to tRPC:** tRPC (`/api/trpc`) is the web app's own data layer and
  `/api/cli/*` the CLI's; neither is a public contract. v1 reads through the
  same loaders, so the API and the pages never disagree.
- **Versioning:** the major version is in the path, and v1 only changes by
  adding. The rules (envelope, error codes, pagination, CORS, caching, rate
  limits, API keys) are [`docs/API_V1.md`](docs/API_V1.md).
- **OpenAPI:** `apps/web/lib/api/v1/openapi.ts` is served at
  `/api/v1/openapi.json`, committed as
  [`docs/api/openapi-v1.json`](docs/api/openapi-v1.json) and checked for drift
  and breaking changes in CI. The `/docs/api` pages are rendered from that
  snapshot, and `e2e/api-v1.spec.ts` validates every endpoint against it.
- **SDK:** [`@signet/sdk`](packages/sdk) is a typed client over v1 (it moved
  off tRPC in 0.1.0), with its response types generated from the snapshot.

---

## Components

| Path | Role | Runtime |
| --- | --- | --- |
| `apps/web` | Next.js App Router — marketing, profiles, contract pages, docs, dashboard, tRPC, `/api/v1`, SIWS auth | Vercel |
| `apps/indexer` | Long-running worker: attestation, deployment, operations, activity, executable refresh, invocations | Container (GHCR image) |
| `packages/contracts/identity-registry` | Soroban `claim`/`release`/`admin_revoke` registry; emits the event stream. Immutable — a defect is recovered by migrating to a new contract, per [`docs/CONTRACT_MIGRATION.md`](docs/CONTRACT_MIGRATION.md) | Stellar network |
| `packages/db` | Prisma schema + client (`Profile`, `Wallet`, `Contract`, `ContractSpec`, `ContractWasmVersion`, `ContractInvocation`, `Operation`, `ContractSnapshot`, `ApiKey`, …) | PostgreSQL |
| `packages/spec` | The shared spec reader: WASM → `SpecJson` v1 | web, visualiser |
| `packages/visualiser` | The contract diagram, from a spec | web, CLI (embedded bundle) |
| `packages/sdk` | External SDK over `/api/v1` (ESM + browser bundle) | consumer apps |
| `packages/types` | Shared TypeScript types, mirrored to Go for the CLI | — |
| `cli` | The `signet` CLI (Go): link, status, whoami, contexts, `signet dev`, sandbox | developer machine |
| `sandbox/simulator` | `signet-simulator` (Rust): the Soroban host over a forked ledger | developer machine |
| `examples/grant-portal` | A runnable integration of the API through the SDK | example |
| `infra` | Local Postgres (`docker/docker-compose.yml`) + `deploy-contract.sh` | dev / ops |

---

## Deployed vs operational-only

**Deployed & serving traffic today**

- **Web app** — built and hosted on Vercel via git integration:
  landing, `/how-it-works`, `/handles`, and
  profiles at `/p/{handle}` for every handle bound on the registry. The tRPC API
  and SIWS auth surface ship with it.
- **Identity Registry contract** — deployed to Stellar **testnet** on
  **2026-07-09** at `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`
  and `initialize`d. Set `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` (web) and
  `INDEXER_REGISTRY_CONTRACT_ID` (indexer) to that id to activate the claim +
  attestation flow. Not yet deployed to mainnet. Once the web app has that id,
  `getProfile` resolves a handle **database → chain**, so a handle bound
  on-chain renders at `/p/{handle}` immediately — no database or indexer sync
  required.

**Code-complete but operational-only** (built, tested, and containerised —
needs provisioning to go live; this is "Phase 2")

- **Indexer worker** — packaged by [`apps/indexer/Dockerfile`](apps/indexer/Dockerfile)
  and published to GHCR by the opt-in [`deploy.yml`](.github/workflows/deploy.yml)
  (`migrate` → build/push image), gated on the `DEPLOY_ENABLED` repo variable.
  It runs Flow 1 + Flow 2 continuously once pointed at a database.
- **PostgreSQL + migrations** — Prisma schema and migrations exist; a local
  instance is provided by `infra/docker/docker-compose.yml`, and production
  migrations run via `pnpm db:deploy` in the deploy workflow. Everything reading
  the DB degrades gracefully to live chain and Horizon reads until `DATABASE_URL`
  is set.

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
| `DATABASE_URL` | web, indexer, db | Optional for web (`/p` falls back to chain + Horizon); required for indexer |
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

[`ci.yml`](.github/workflows/ci.yml) runs on every push/PR (some jobs only
when their paths changed):

- **docs** — relative link/anchor check, env-var lockstep with `.env.example`,
  `pnpm`/`cargo` script names cited in markdown (`scripts/check-docs.mjs`);
  generated-code sync (wallet sources and the CLI wire types in Go, contract
  errors); the OpenAPI snapshot's freshness and breaking-change check
- **web** — `lint` · `typecheck` · `test` · `build` for every workspace
  package, the SDK's generated types and build output (Node smoke, browser
  bundle budget, `npm pack` contents), the CLI's embedded visualiser bundle,
  and per-route JS budgets
- **cli** — the Go CLI on Linux, macOS and Windows: build, `vet`, tests
  (with `-race` where cgo is available) including help and output goldens,
  `golangci-lint`, the generated Go client stub, and a cross-compile smoke build
- **contracts** — `cargo test` + `stellar contract build`
- **spec-fixtures**, **sandbox-fixtures** — recorded fixtures match a fresh build
- **e2e** — Playwright against a production build without a database (and the
  SDK's browser bundle, and the local UI's accessibility and security)
- **e2e-linked** — the `@db` Playwright specs against Postgres with the #463
  fixture: the linked flow, contract pages, and the `/api/v1` contract tests
- **sandbox**, **sandbox-bench**, **sandbox-e2e** — the simulator's Rust
  tests, its benchmarks against a calibrated baseline, and `signet dev --ci`
  from source, offline
- **replay**, **replay-identical**, **simulator-size** — bundle replay on
  every OS, identical results across them, and the binary's size budget
- **security** — `pnpm audit` + `cargo audit` (advisory)

Separate workflows: [`deploy.yml`](.github/workflows/deploy.yml) (opt-in, so
forks and un-provisioned clones never deploy), the CLI and simulator release
pipelines, the scheduled testnet and production checks, and
[`load-test.yml`](.github/workflows/load-test.yml) (manual, localhost only).
