# Signet — Issue Backlog

Source of truth for the open-source backlog. Each entry below maps 1:1 to a GitHub
issue: the heading is the issue title, `Labels` are applied verbatim, and
`Acceptance` is what a reviewer checks before merging.

**Points tiers** (contributor economy): `points: trivial` = 100 · `points: medium` = 150 · `points: high` = 200.

🔒 = maintainer-owned. These close the on-chain/product loop, need production
secrets, and are time-critical — they are listed for the record, not for pickup.

## Labels

```bash
gh label create "points: trivial" -c "#c5def5" -d "100 pts"
gh label create "points: medium"  -c "#5319e7" -d "150 pts"
gh label create "points: high"    -c "#b60205" -d "200 pts"
gh label create "area: contract"  -c "#000000"
gh label create "area: web"       -c "#168700"
gh label create "area: indexer"   -c "#fbca04"
gh label create "area: sdk"       -c "#0075ca"
gh label create "area: infra"     -c "#bfd4f2"
```

## Getting started

```bash
pnpm install
pnpm --filter @signet/web dev          # web app, no database needed
pnpm test                              # 35 TS tests
cd packages/contracts && cargo test    # 14 contract tests
```

Node 22+ and pnpm 9+ required. The deployed testnet Identity Registry is
`CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`; set it as
`NEXT_PUBLIC_IDENTITY_REGISTRY_ID` to work on anything claim-related.

---

# A · Soroban contract + on-chain reads

### 1. 🔒 Add a server-side registry read helper
`Labels: area: contract, points: high`

Nothing in the web app reads the Identity Registry. Add `lib/server/registry-read.ts`
exposing `resolveHandle(handle)`, `lookupWallet(address)` and `boundCount()` built on
`rpc.Server.simulateTransaction` — read-only, no signing, no database.

**Acceptance:** all three functions return live values against the testnet registry;
they return `null`/`0` (never throw) when `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` is unset;
unit tests cover the unconfigured and simulation-error paths.

### 2. 🔒 Resolve profiles from the chain in `getProfile()`
`Labels: area: web, points: high`

`lib/profiles.ts:59` goes database → static manifest, so a handle claimed on-chain
renders a 404. Insert the chain lookup between the two: **DB → chain → static**.

**Acceptance:** a handle bound on testnet but absent from `public/data/profiles.json`
renders at `/p/{handle}`; the curated demo profiles keep working with no DB.

### 3. 🔒 Resolve the signed-in wallet's handle without a database
`Labels: area: web, points: medium`

`lib/server/account.ts:44` returns `handle: null` whenever `DATABASE_URL` is unset, so
the dashboard always says "No handle is bound to this wallet yet" — even right after a
successful on-chain claim. Fall back to `lookupWallet(address)`.

**Acceptance:** with no `DATABASE_URL` and a claimed wallet, `/app` shows the bound
handle and the "View profile ↗" link.

### 4. 🔒 Render freshly claimed handles instead of caching a 404
`Labels: area: web, points: trivial`

`app/p/[handle]/page.tsx:5` pre-renders only curated handles. Add explicit
`export const dynamicParams = true;` and `export const revalidate = 60;`.

**Acceptance:** a handle claimed after the last build resolves on the deployed site
without a redeploy.

### 5. 🔒 Wait for the claim transaction to actually succeed
`Labels: area: web, points: medium`

`lib/registry.ts:70` returns immediately after `sendTransaction`, whose status is
`PENDING`. The UI prints `Claimed! tx …` even when the contract then panics
(duplicate handle, wallet already bound, `NotInitialized`). Poll `getTransaction`
until `SUCCESS`/`FAILED`, with a timeout.

**Acceptance:** claiming an already-taken handle surfaces a failure, not a success.

### 6. Map contract error codes to human messages
`Labels: area: web, area: contract, points: medium, good first issue`

Failed claims surface raw XDR-ish JSON. Map the contract's `Error` variants to
readable strings ("That handle is taken", "This wallet already has a handle").

**Acceptance:** every variant in `identity-registry/src/lib.rs` has a message; unknown
codes fall back to a generic string; covered by a unit test.

### 7. Contract: `transfer_handle(handle, new_wallet)`
`Labels: area: contract, points: high`

A developer rotating deploy keys must currently `release` then re-`claim`, racing anyone
watching the ledger. Add an atomic transfer requiring `require_auth` from the current
owner, emitting a `transferred` event.

**Acceptance:** new tests cover happy path, unauthorized caller, unknown handle, and
target wallet that already holds a handle; `count()` stays correct.

### 8. Contract: emit an event from `admin_revoke`
`Labels: area: contract, points: medium`

`claim` and `release` publish events; `admin_revoke` (`lib.rs:118`) does not, so the
indexer's attestation worker silently misses admin revocations.

**Acceptance:** a `revoked` event is published with the same topic shape as `released`;
contract test asserts it; `decodeEvent` in the indexer handles it.

### 9. Contract: reserved-handle blocklist
`Labels: area: contract, points: medium`

Handles like `p`, `app`, `api`, `admin`, `how-it-works` collide with app routes.
Reject them in `claim` (`lib.rs:76`).

**Acceptance:** blocklist constant with the current route names; tests assert rejection;
existing charset validation untouched.

### 10. Contract: `resolve_many` batch read
`Labels: area: contract, points: medium`

The planned `/handles` directory would need one simulate per handle. Add a bounded
batch read (cap the input length).

**Acceptance:** returns results positionally with `None` for unbound handles; rejects
oversized input; tests cover both.

---

# B · Indexer

### 11. Paginate Horizon operations
`Labels: area: indexer, points: medium`

`workers/operations.ts` reads only the first Horizon page, so wallets with more
activity than one page are silently truncated.

**Acceptance:** follows `next` links until the stored cursor is reached; bounded by a
max-pages guard; test with a mocked paginated response.

### 12. Backoff and retry on Horizon errors
`Labels: area: indexer, points: medium`

A single 429 or 5xx currently kills the tick. Add exponential backoff with jitter.

**Acceptance:** retries transient failures, gives up after N attempts and logs
structured context; unit test with a mock that fails twice then succeeds.

### 13. Test cursor resumption in the attestation worker
`Labels: area: indexer, points: medium`

`workers/attestation.ts` stores an `attestation` cursor but nothing verifies a restart
resumes from it rather than re-reading `INDEXER_EVENT_WINDOW_LEDGERS`.

**Acceptance:** test asserts a second run starts from the stored ledger and does not
re-apply already-seen events.

### 14. Idempotency test for the operations worker
`Labels: area: indexer, points: medium`

Upserts are keyed on the Horizon op id but nothing guards the invariant.

**Acceptance:** running the worker twice over the same fixture leaves the row count
unchanged.

### 15. Graceful shutdown on SIGTERM
`Labels: area: indexer, points: trivial, good first issue`

The container is killed mid-tick on deploy, risking a half-written cursor.

**Acceptance:** SIGTERM/SIGINT finish the current tick, disconnect Prisma, exit 0.

### 16. Counter metrics in the structured logs
`Labels: area: indexer, points: medium`

Per-tick log line with `opsUpserted`, `eventsDecoded`, `walletsScanned`, `durationMs`.

**Acceptance:** one JSON line per tick via `src/logger.ts`; no per-record log spam.

### 17. Docker healthcheck for the indexer
`Labels: area: indexer, points: trivial, good first issue`

`apps/indexer/Dockerfile` has no `HEALTHCHECK`, so a wedged worker looks healthy.

**Acceptance:** worker touches a liveness file each successful tick; `HEALTHCHECK`
fails when it goes stale.

### 18. Document and test the `--reseed` flag
`Labels: area: indexer, points: trivial, documentation, good first issue`

`pnpm indexer:seed` exists in the root `package.json` but is undocumented.

**Acceptance:** documented in `apps/indexer` README; a test asserts reseeding is
idempotent.

---

# C · Web product

### 19. 🔒 Landing page claims "Real on-chain data" over synthetic data
`Labels: area: web, points: trivial`

`app/(marketing)/sections/demos.tsx:37` renders `Live demo · Real on-chain data`. The
demo profiles are synthetic — the paragraph directly below says so. The label is false
and contradicts the rest of the page.

**Acceptance:** label reads `Live demo · Synthetic testnet data`; no other surface
claims the demo data is real.

### 20. Render live Horizon activity for chain-bound profiles
`Labels: area: web, points: high`

`getOperations` (`lib/profiles.ts:70`) reads the DB then falls back to static demo JSON,
so a claimed profile with no Postgres shows nothing. Add `lib/server/horizon.ts`
fetching `invoke_host_function` operations for the bound wallet.

**Acceptance:** a claimed handle shows its real testnet operations with no database;
failures degrade to an empty list, never a 500; response cached/revalidated.

### 21. Replace the `window.prompt` handle claim with a real form
`Labels: area: web, points: medium`

`connect-wallet.tsx:47` collects the handle via `window.prompt`, which some browsers
block and which does no validation before spending a transaction.

**Acceptance:** inline input, client-side `^[a-z0-9_-]{1,32}$` validation mirroring the
contract, disabled submit while busy, success links to `/p/{handle}`.

### 22. Don't link synthetic data to a block explorer
`Labels: area: web, points: trivial, good first issue`

`p/[handle]/page.tsx:30,147` links demo transaction hashes and wallets to
stellar.expert, where they resolve to nothing.

**Acceptance:** explorer links render only for chain/DB-sourced profiles; static demo
profiles show the hash as plain text. Supersede this once issue 32 lands.

### 23. `/handles` — public directory of bound handles
`Labels: area: web, points: high`

Nothing lists who is on Signet. Build a directory from the registry's `claimed`/
`released` events (or `count` + `resolve_many` once issue 10 lands).

**Acceptance:** paginated list linking to each `/p/{handle}`; works without a database;
empty state when the registry has no bindings.

### 24. Empty state for a profile with no operations
`Labels: area: web, points: trivial, good first issue`

A freshly claimed handle renders an empty stats block and a bare list.

**Acceptance:** explanatory empty state; stats show zeros rather than `NaN`.

### 25. Paginate the operations list
`Labels: area: web, points: medium`

`/p/{handle}` renders every operation at once.

**Acceptance:** first 25 shown with a "Load more" control; keeps working with
JavaScript disabled for the initial render.

### 26. Copy-to-clipboard for the wallet address
`Labels: area: web, points: trivial, good first issue`

The address is truncated (`p/[handle]/page.tsx:147`) with no way to copy it in full.

**Acceptance:** copy button with a confirmation state and an accessible label.

### 27. Dashboard wallets page reads real bindings
`Labels: area: web, points: medium`

`(dashboard)/app/wallets/page.tsx` renders an empty list without a database.

**Acceptance:** uses the chain lookup from issue 1; shows the wallet with source
`onchain`; honest empty state when the registry is unconfigured.

### 28. Honest disabled state in the profile editor
`Labels: area: web, points: trivial, good first issue`

`profile-editor.tsx` submits and only then throws "Profile editing requires a configured
database".

**Acceptance:** the form is disabled up front with an explanation when editing is
unavailable.

### 29. Respect `prefers-reduced-motion`
`Labels: area: web, points: medium`

The marketing page runs GSAP, Lenis smooth scroll and framer-motion unconditionally.

**Acceptance:** with the OS setting enabled, smooth scroll is off and entrance
animations resolve to their final state immediately.

### 30. Accessibility pass on the nav and claim flow
`Labels: area: web, points: medium`

Missing focus styles and accessible names on the `ConnectWallet` button states.

**Acceptance:** keyboard-reachable with a visible focus ring, `aria-label` reflecting
the current action, status text announced via a live region.

### 31. 404 page should offer to claim the handle
`Labels: area: web, points: trivial, good first issue`

`app/not-found.tsx` is generic; the most common 404 is an unclaimed handle.

**Acceptance:** when the path looks like `/p/{valid-handle}`, offer a claim link.

---

# D · Demo-data honesty

### 32. 🔒 Generate the demo profiles from real testnet activity
`Labels: area: web, points: high`

`public/data/*.json` contains Horizon-shaped records — transaction hashes, ledger ids —
for accounts that do not exist: `GASAAEJC…EMCD` and `GBVBJEP2…H3EQ` both 404 on
`horizon-testnet.stellar.org`. The data is labelled synthetic on `/p`, but every
explorer link is dead.

Add `scripts/seed-testnet-demo.ts`: generate keypairs, fund via friendbot, submit real
operations (including a `claim` against the deployed registry), then dump the accounts'
real Horizon operations into `public/data/{handle}.json`.

**Acceptance:** all three demo wallets resolve on Horizon; every rendered transaction
hash opens a real stellar.expert page; the JSON shape is unchanged.

### 33. Keep demo addresses in sync across packages
`Labels: area: indexer, points: trivial, good first issue`

`apps/indexer/src/seed-data.ts` and `apps/web/public/data/profiles.json` carry the same
addresses in two places and can drift.

**Acceptance:** one shared source (e.g. `@signet/types` or a JSON import) consumed by
both; no duplicated literals.

### 34. CI guard against dead demo data
`Labels: area: infra, points: medium`

Nothing catches demo wallets that stop resolving.

**Acceptance:** a non-blocking CI job queries Horizon for each demo wallet and fails
with a clear message when one 404s.

### 35. Sitemap and OG images include chain-bound handles
`Labels: area: web, points: trivial`

`app/sitemap.ts` lists only curated handles from the static manifest.

**Acceptance:** sitemap includes handles bound on-chain; OG image renders for them too.

---

# E · SDK and API

### 36. Publish `@signet/sdk` v0.1.0 to npm
`Labels: area: sdk, points: medium`

The SDK is workspace-only, so no integrator can install it.

**Acceptance:** published under a public scope with a README quickstart that runs
against the live API; `prepublishOnly` runs build + tests; version tagged in git.

### 37. SDK: timeout and retry options
`Labels: area: sdk, points: medium`

`fetch` calls hang indefinitely on a stalled network.

**Acceptance:** configurable timeout via `AbortController` plus bounded retries on 5xx;
defaults documented; tests with a mocked fetch.

### 38. SDK: typed error classes
`Labels: area: sdk, points: trivial, good first issue`

Callers can't distinguish "not found" from "network down" — everything is a bare
`Error`.

**Acceptance:** `NotFoundError`, `NetworkError`, `ApiError` (with status) exported and
covered by tests.

### 39. Expose registry reads through tRPC
`Labels: area: web, area: sdk, points: medium`

Add `registry.resolve`, `registry.lookup` and `registry.count` procedures on top of
issue 1, then surface them in the SDK.

**Acceptance:** procedures validated with the shared handle regex, rate-limited like the
existing routes, covered by tests.

### 40. Generate API reference docs from the tRPC router
`Labels: area: sdk, documentation, points: medium`

Integrators have no API reference.

**Acceptance:** generated route/input/output reference committed under `docs/` and
regenerated by a script.

---

# F · Security and auth

### 41. Implement SEP-10 web authentication
`Labels: area: web, points: high`

`lib/auth.ts` implements a custom Sign-In-With-Stellar challenge. SEP-10 is the
ecosystem standard and unlocks interoperability with existing Stellar tooling.

**Acceptance:** compliant challenge/verify endpoints (correct home domain, web auth
domain, timebounds, signature checks), tests against the spec's vectors, SIWS kept
working during migration.

### 42. Nonce-based CSP, drop `'unsafe-inline'` from `script-src`
`Labels: area: web, points: high`

`next.config.js:7` keeps `script-src 'self' 'unsafe-inline'` for Next's bootstrap.

**Acceptance:** per-request nonce injected via middleware and consumed by the CSP
header; app runs clean with no console CSP violations; `style-src` documented as
still needing `'unsafe-inline'` for inline React styles.

### 43. Redis-backed rate limit store
`Labels: area: web, points: medium`

`lib/rate-limit.ts` uses an in-memory store, which resets on every serverless cold start.

**Acceptance:** `RateLimitStore` implementation in `lib/rate-limit-redis.ts` wired via
`setRateLimitStore()` when the Redis env vars exist, memory store otherwise; tests
against a mock client.

### 44. Document session revocation
`Labels: documentation, points: trivial, good first issue`

`SIGNET_SESSIONS_VALID_AFTER` invalidates issued sessions but is documented nowhere.

**Acceptance:** `SECURITY.md` operator section explains when and how to set it, with a
copy-pasteable command.

### 45. CSP entries for optional wallet modules
`Labels: area: web, points: trivial, good first issue`

`connect-src` (`next.config.js:12`) covers Stellar endpoints only; enabling
WalletConnect or Lobstr in Stellar Wallets Kit would be blocked.

**Acceptance:** required origins added (or documented as a commented block) so enabling
a module doesn't silently fail.

---

# G · Infrastructure, CI, onboarding

### 46. Contributor onboarding files
`Labels: documentation, points: trivial, good first issue`

No `CONTRIBUTING.md`, issue templates or PR template exist.

**Acceptance:** `CONTRIBUTING.md` (setup, gates, commit style, points tiers),
`.github/ISSUE_TEMPLATE/{bug,feature}.yml`, `.github/pull_request_template.md`.

### 47. Run the Playwright smoke suite in CI
`Labels: area: infra, points: medium`

`e2e/smoke.spec.ts` exists but is excluded from tsconfig, eslint and every CI gate, so
it never runs.

**Acceptance:** a CI job installs browsers, builds the web app and runs `test:e2e`;
cached to keep it under a few minutes.

### 48. Wasm size budget in the contract CI job
`Labels: area: contract, area: infra, points: trivial`

The contract is ~9 KB; nothing catches a regression that bloats it.

**Acceptance:** the Rust job fails when the release wasm exceeds a documented budget.

### 49. `ARCHITECTURE.md`
`Labels: documentation, points: trivial`

The README diagram is labelled "planned" but the claim → event → attestation → DB and
wallet → operations → DB paths are code-complete.

**Acceptance:** a document describing the real data flows, what is deployed, and what is
still operational-only, linked from the README.

### 50. Grant proposal with itemized budget and milestones
`Labels: documentation, points: medium`

There is no proposal document — only scattered notes across README and `NEXT_STEPS.md`.

**Acceptance:** `PROPOSAL.md` with problem statement, itemized budget buckets, dated
milestones, and a fix-log of resolved issues with their regression tests.

---

# H · Documentation

Filed 2026-07-30 as GitHub issues #127–#136. These strengthen what an outsider can
learn, verify and reproduce from the repo alone. None of them change a runtime
capability.

### 51. Add a LICENSE and license metadata
`Labels: documentation, good first issue, points: trivial`

The repo has no `LICENSE` file, and every `package.json` omits a `license` field.
Nobody can legally fork or vendor Signet, and `@signet/sdk` cannot be published to
npm (#36) without one.

**Acceptance:** `LICENSE` at the root (Apache-2.0) with the correct copyright line;
`"license": "Apache-2.0"` in the root and every workspace package; `license` in
`packages/contracts/identity-registry/Cargo.toml`; a License section in the README.

### 52. README describes a pre-deployment build that no longer exists
`Labels: documentation, points: trivial, area: web`

The README says the claim flow shows an honest "Phase 2" message *until* a contract
id is configured — but the registry has been live on testnet since 2026-07-09. It
lists "Deploy the registry" as upcoming, labels the architecture diagram `(planned)`
when the claim → event → attestation path is code-complete, and states 13 contract
tests where `cargo test` reports 14.

**Acceptance:** a Status/Deployments table with network, contract id and deploy date;
the claim flow documented as live when `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` is set; the
`(planned)` diagram split into implemented vs operational-only; test counts matched to
actual output. No claim may describe synthetic data as real activity.

### 53. `docs/DEPLOYMENT.md` — reproducible self-host guide
`Labels: documentation, points: medium, area: infra`

Deploying today means reading `infra/deploy-contract.sh`, 40 lines of comments in
`.env.example`, and `MAINTAINER.md` — a TODO list, not a guide.

**Acceptance:** prerequisites; key generation and funding; wasm build; running
`infra/deploy-contract.sh`; `initialize(admin)`; capturing the contract id; Netlify
and Vercel deploys with required production env vars including `SIGNET_AUTH_SECRET`;
a post-deploy verification checklist; a rollback note. Every command verified end to
end on testnet. Linked from the README.

### 54. `docs/ENVIRONMENT.md` — one reference table for every env var
`Labels: documentation, good first issue, points: trivial, area: infra`

`.env.example` mixes declarations with deploy instructions and CLI bug workarounds.

**Acceptance:** one table — variable · consumed by · required/optional · default ·
behaviour when unset — covering every variable in `.env.example`. Documents the
degraded-but-honest modes: no `DATABASE_URL` → static fallback, no registry id →
claim disabled, no `INDEXER_REGISTRY_CONTRACT_ID` → attestation worker no-ops.
`.env.example` trimmed to declarations plus a pointer.

### 55. `packages/sdk/README.md` — quickstart and API reference
`Labels: documentation, points: trivial, area: sdk`

The SDK has no README, so publishing to npm (#36) would ship an empty package page.

**Acceptance:** description, install line, runnable quickstart against the public API,
a method reference for every export (params, return shape, thrown errors), config
options, Node/browser compatibility note. `description`, `repository`, `homepage`,
`keywords` filled in `packages/sdk/package.json`.

### 56. `docs/INDEXER.md` — operator runbook
`Labels: documentation, points: medium, area: indexer`

Two workers, cursors, `--reseed` and registry event reads are documented nowhere
outside the source.

**Acceptance:** each worker (input, output tables, cadence); cursor storage and
resumption; ledger-window cold start; running locally and in Docker; what each
structured log line means; safe restart and backfill; a troubleshooting table for
Horizon rate limits, Postgres unreachable, registry id unset, cursor ahead of ledger.

### 57. `docs/REGISTRY_INTEGRATION.md` — integrate against the deployed registry
`Labels: documentation, points: medium, area: contract`

Event topics and payload layout are undocumented, `contracterror` variants have no
published numeric values, and there is no client-side example.

**Acceptance:** deployed testnet contract id and passphrase; a table of every error
variant with its numeric discriminant and trigger; exact topic tuple and data layout
per event; `@stellar/stellar-sdk` snippets for read-only simulation and for a signed
`claim` submission; a worked example reconstructing the handle set from events.
Snippets verified against the live deployment.

### 58. `docs/DEMO_DATA.md` — provenance and regeneration of the demo profiles
`Labels: documentation, points: trivial, area: web`

Nothing records where the synthetic fixtures came from, which addresses they use, how
to regenerate them, or the rule keeping them from being presented as real activity.

**Acceptance:** the honesty policy (always labelled at every rendering surface, never
explorer-linked as real); generating accounts and how they were produced; the fixture
JSON schema; steps to regenerate or add one; the rule for graduating a handle from
fixture to chain-bound. Referenced by #32, #33, #34, #46.

### 59. Docs CI: link check and stale-reference guard
`Labels: documentation, points: medium, area: infra`

Docs drift silently — the README already contradicts `cargo test`.

**Acceptance:** a `docs` CI job failing on broken relative links or dead anchors in
tracked `*.md`; env vars referenced in docs but absent from `.env.example` (and vice
versa); and `pnpm`/`cargo` scripts named in code fences that do not exist. Runs on PRs
touching `**/*.md`, `.env.example` or workflows; under 60s; failures name file and line.

### 60. `docs/TROUBLESHOOTING.md` — first-run failures and their fixes
`Labels: documentation, good first issue, points: trivial`

Known traps are scattered across `.env.example` comments and README blockquotes.

**Acceptance:** a symptom → cause → fix table covering at minimum the stellar CLI
25.2.0 `rpc-url is used but network passphrase is missing` bug and its workaround;
manual friendbot funding; Node < 22 build failures; missing `wasm32v1-none` target;
running the web app with no `DATABASE_URL`; the claim button showing Phase 2; and the
indexer starting with no registry id. Every entry reproducible and fix-verified.

---

## Summary

| Area | Issues | Trivial | Medium | High |
|---|---|---|---|---|
| A · Contract + on-chain reads | 10 | 1 | 6 | 3 |
| B · Indexer | 8 | 3 | 5 | 0 |
| C · Web product | 13 | 6 | 5 | 2 |
| D · Demo-data honesty | 4 | 2 | 1 | 1 |
| E · SDK and API | 5 | 1 | 4 | 0 |
| F · Security and auth | 5 | 2 | 1 | 2 |
| G · Infra, CI, onboarding | 5 | 3 | 2 | 0 |
| H · Documentation | 10 | 6 | 4 | 0 |
| **Total** | **60** | **24** | **28** | **8** |

Seven issues (1–5, 19, 32) are maintainer-owned and blocked on production deploy
access. The remaining 53 are open for contribution.
