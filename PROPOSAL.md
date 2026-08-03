# Signet — Grant Proposal

**A verifiable developer career record built on Stellar/Soroban.**

| | |
| --- | --- |
| Project | Signet ([`README.md`](README.md)) |
| Requested | **$67,650 USD** over 9 months |
| Period | 2026-08-01 → 2027-04-30 |
| Status at time of writing | Web app deployed; Identity Registry code-complete and unit-tested but **not deployed on-chain**; indexer containerised but not provisioned |
| Prepared | 2026-07-28 |

This document consolidates material previously scattered across
[`README.md`](README.md), [`NEXT_STEPS.md`](NEXT_STEPS.md),
[`ARCHITECTURE.md`](ARCHITECTURE.md), and [`BUILD_REPORT.md`](BUILD_REPORT.md)
into a single proposal: the problem, an itemized budget, dated milestones, and a
fix-log of what has already been resolved and how each fix is held in place.

---

## 1. Problem statement

**A smart-contract developer's most valuable professional evidence is public,
permanent, and unusable.**

Every contract a developer has deployed, every upgrade they have shipped, every
protocol they have kept running is written to a public ledger and stays there.
Yet when that developer applies for a role, bids for a grant, or asks a DAO for
signing authority, the ledger is worthless to them as a credential. The evidence
exists; the *attribution* does not.

Three gaps produce that outcome:

1. **No trustworthy binding from identity to wallet.** A GitHub profile can list
   a wallet address; nothing proves the person controls it. Any claim of the
   form "this address is mine" that is not signed by that address is a
   self-assertion, and platforms that accept self-assertions become
   impersonation surfaces. Conversely, a binding held in a company's database is
   only as durable as the company.

2. **Raw chain data is not a career record.** Horizon and Soroban RPC return
   operations, ledger entries, and events. Turning that into "deployed and has
   operated a lending protocol for 14 months, 40k operations, no incidents"
   requires continuous indexing, deployment attribution, and activity
   aggregation that no individual developer will run for themselves.

3. **The existing alternatives invert the trust model.** Centralised developer
   profiles ask the reader to trust the platform's claims about the developer.
   A ledger-derived record should ask the reader to trust only the ledger, with
   the platform reduced to a renderer. That inversion is the entire product
   thesis, and it is only achievable if the binding itself is on-chain.

### Why this is fundable now, and what the money is actually for

Signet has already built the hard part and can prove it: the Identity Registry
Soroban contract is implemented with `claim` / `release` / `transfer_handle` /
`admin_revoke`, enforces ownership through `require_auth`, emits an event stream
that makes handle enumeration an off-chain concern, and is covered by 18 `cargo`
tests. The indexer implements both data flows end to end. The web app renders
profiles today.

**What is missing is not code — it is operation.** As
[`ARCHITECTURE.md`](ARCHITECTURE.md) states plainly, the registry is *not yet
deployed on-chain*, so the claim flow shows an honest "Phase 2" message rather
than binding anything; the indexer has no database to write to; and the three
demo profiles at `/p/{handle}` render **synthetic testnet data** because there
is no live binding to render instead. Every remaining gap in the product traces
back to that one fact.

The consequence is visible in the issue tracker and is the most honest argument
for this grant: a self-sovereign identity layer cannot be finished as
uncompensated evenings work, because past the code the remaining costs are
*recurring and external* — a database that must stay up, an RPC provider that
must be paid, an indexer that must not fall over at 3am, and a contract audit
that must be commissioned before a single mainnet binding is written. This
proposal funds exactly that transition: from a code-complete repository to an
operating public good, with the contract audited before it holds anything real.

### Non-goals

- **A token.** Signet has no token and this grant does not fund one.
- **Custody.** Signet never holds keys or funds; the claim transaction is signed
  in the user's wallet and submitted directly.
- **Scoring humans.** The record is evidence, not a ranking. Reputation surfaces
  stay derived and explainable, never an opaque number.
- **Chains beyond Stellar** during the grant period.

---

## 2. Scope of work

Five workstreams, mapped to the open issue tracker so progress is externally
auditable.

| # | Workstream | What it delivers | Issues |
| --- | --- | --- | --- |
| W1 | **Phase 2 activation** | Registry deployed to testnet then mainnet; Postgres provisioned; indexer running continuously; demo profiles backed by real activity | #56, #57, #58, #43, #46 |
| W2 | **Chain-native reads** | Profiles resolve from the registry rather than a curated manifest; freshly claimed handles render immediately; claims wait for real confirmation | #25, #26, #27, #28, #29, #44, #51, #55 |
| W3 | **Indexer reliability** | Pagination, backoff, cursor resumption, idempotency, graceful shutdown, healthcheck | #35, #36, #37, #38, #39, #41, #42 |
| W4 | **SDK, API, and surface polish** | Published `@signet/sdk`, typed errors, registry reads over tRPC, generated API reference, profile UX | #60, #61, #62, #63, #64, #48, #49, #50, #53, #59 |
| W5 | **Security and audit** | SEP-10 auth, nonce-based CSP, Redis-backed rate limiting, session revocation, external contract audit | #65, #66, #67, #68 |

Cross-cutting: contributor onboarding (#70), Playwright smoke suite in CI (#71),
and closing the regression-test gaps identified in §5.

---

## 3. Itemized budget

Blended engineering rate: **$65/hour**. All figures USD.

### 3.1 Engineering

| Bucket | Scope | Effort | Cost |
| --- | --- | --- | --- |
| B1 — Chain-native identity reads | W2: server-side registry read helper, `getProfile()` resolving from chain, signed-in handle resolution without a DB, revalidation on claim, transaction confirmation, demo-address sync and CI guard | 160 h | $10,400 |
| B2 — Indexer reliability and operations | W3: Horizon pagination, backoff/retry, cursor-resumption and idempotency tests, SIGTERM handling, Docker healthcheck, `--reseed` documentation | 120 h | $7,800 |
| B3 — Contract features and audit prep | Reserved-handle blocklist (#33), `resolve_many` batch read (#34), remediation of audit findings, deployment runbook | 60 h | $3,900 |
| B4 — Profile surface and UX | W4 UI half: live Horizon activity for bound profiles, empty states, operation pagination, clipboard, reduced-motion, sitemap/OG for bound handles | 120 h | $7,800 |
| B5 — SDK and integrator API | `@signet/sdk` v0.1.0 to npm, timeout/retry options, typed error classes, registry reads over tRPC, generated API reference | 90 h | $5,850 |
| B6 — Security engineering | SEP-10 web authentication, nonce-based CSP dropping `unsafe-inline`, Redis-backed rate-limit store, documented session revocation | 80 h | $5,200 |
| B7 — Testing, CI, and regression-gap closure | Playwright smoke suite in CI, component tests for the claim form and accessibility affordances, indexer metrics assertions — the gaps listed in §5 | 50 h | $3,250 |
| B8 — Documentation and contributor onboarding | `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / issue templates (#70), integrator guide, quarterly reporting | 40 h | $2,600 |
| | **Engineering subtotal** | **720 h** | **$46,800** |

### 3.2 External services

| Bucket | Scope | Cost |
| --- | --- | --- |
| B9 — Independent contract audit | External security review of `packages/contracts/identity-registry` before mainnet deployment, including a remediation round and a public report | $12,000 |

### 3.3 Infrastructure (12 months)

| Line item | Rate | Cost |
| --- | --- | --- |
| Managed PostgreSQL (indexer write path, profile reads) | $45/mo × 12 | $540 |
| Soroban RPC provider, paid tier (event history beyond the public retention window) | $99/mo × 12 | $1,188 |
| Indexer container host (2 vCPU, always-on) | $24/mo × 12 | $288 |
| Web hosting (Netlify, team tier) | $19/mo × 12 | $228 |
| Error tracking and uptime monitoring | $29/mo × 12 | $348 |
| Domain and TLS | — | $108 |
| | **Infrastructure subtotal** | **$2,700** |

### 3.4 Total

| | |
| --- | --- |
| Engineering (B1–B8) | $46,800 |
| Contract audit (B9) | $12,000 |
| Infrastructure (12 mo) | $2,700 |
| **Subtotal** | **$61,500** |
| Contingency (10%) — audit remediation overrun, RPC/DB tier escalation under load | $6,150 |
| **Total requested** | **$67,650** |

Infrastructure is funded for 12 months against a 9-month delivery period
deliberately: the service must stay up for a quarter past the final milestone
while a sustainability path (§7) is settled. Unspent contingency is returned.

---

## 4. Milestones

Each milestone lands as merged PRs closing the listed issues, with CI green
(`lint · typecheck · test · build`, `cargo test`, wasm size budget) and the
acceptance criteria of each issue met.

### M1 — Phase 2 activation (testnet) · due **2026-09-15** · $8,000

The registry stops being a repository artifact and starts being a deployed
contract.

- Identity Registry deployed to Stellar **testnet** via
  [`infra/deploy-contract.sh`](infra/deploy-contract.sh); `initialize` called;
  `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` and `INDEXER_REGISTRY_CONTRACT_ID` set.
- Managed Postgres provisioned; `pnpm db:deploy` applied; indexer running
  continuously against testnet.
- Demo profiles regenerated from **real** testnet activity, replacing the
  synthetic records (#56), with demo addresses synced across packages (#57) and
  a CI guard against dead demo data (#58).
- Landing-page copy reconciled with what is actually rendered (#43); explorer
  links suppressed for any remaining synthetic data (#46).

**Verification:** every demo wallet resolves on `horizon-testnet.stellar.org`;
every rendered transaction hash opens a live explorer page; a claim submitted
from a browser wallet appears in the database within one indexer tick.

### M2 — Chain-native reads · due **2026-10-31** · $13,500

The curated manifest stops being the source of truth.

- Server-side registry read helper (#25); `getProfile()` resolves handles from
  the chain (#26); the signed-in wallet's handle resolves without a database
  (#27).
- Freshly claimed handles render instead of caching a 404 (#28); the claim flow
  waits for the transaction to actually succeed before reporting success (#29).
- Bound profiles render live Horizon activity (#44); the dashboard wallets page
  reads real bindings (#51); the 404 page offers to claim the handle (#55).

**Verification:** a handle claimed in a browser is viewable at `/p/{handle}`
with no code change and no manifest edit; regression tests cover chain-resolved
profiles and the confirmation path.

### M3 — Indexer reliability · due **2026-12-15** · $11,000

The worker becomes something that can be left running.

- Horizon operation pagination (#35) and backoff/retry on Horizon errors (#36).
- Cursor-resumption test for the attestation worker (#37); idempotency test for
  the operations worker (#38).
- Graceful shutdown on `SIGTERM` (#39); Docker healthcheck (#41); `--reseed`
  documented and tested (#42).

**Verification:** a wallet with more than one Horizon page indexes completely; a
worker killed mid-tick and restarted produces no duplicate rows; the container
reports unhealthy when the tick loop stalls.

### M4 — SDK, API, and public surface · due **2027-02-13** · $12,000

Third parties can consume the record.

- `@signet/sdk` v0.1.0 published to npm (#60) with timeout/retry options (#61)
  and typed error classes (#62).
- Registry reads exposed through tRPC (#63); API reference generated from the
  router (#64).
- Profile surface completed: empty state (#48), operation pagination (#49),
  clipboard (#50), `prefers-reduced-motion` (#53), sitemap and OG images
  covering chain-bound handles (#59).
- Contributor onboarding files (#70) and the Playwright smoke suite in CI (#71).

**Verification:** an integrator renders a "Verified by Signet" badge from a
clean project using only the published package and the generated docs.

### M5 — Security, audit, and mainnet · due **2027-04-30** · $23,150

The contract is audited before it holds anything real.

- SEP-10 web authentication (#65); nonce-based CSP with `unsafe-inline` dropped
  from `script-src` (#66); Redis-backed rate-limit store (#67); documented
  session revocation (#68).
- Reserved-handle blocklist (#33) and `resolve_many` batch read (#34) landed
  **before** the audit freeze.
- Independent audit of `identity-registry` commissioned, findings remediated,
  report published in-repo.
- Mainnet deployment; production `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` set; indexer
  pointed at mainnet.

**Verification:** the audit report and its remediation commits are public; a
mainnet claim binds, indexes, and renders end to end.

### Reporting

A public progress note at each milestone: issues closed, tests added, spend
against the buckets in §3, and any variance with its cause.

---

## 5. Fix log — resolved issues and their regression tests

Work already completed, unfunded. Each row names the issue, the commit that
closed it, and the test that keeps it closed. Where no automated regression test
exists, the row says so — closing those gaps is funded as bucket **B7**.

| Issue | Fix | Commit | Regression test |
| --- | --- | --- | --- |
| #30 — Map contract error codes to human messages | Every `Error` variant mapped to a readable string; unknown codes fall back to a generic message; Soroban error JSON parsed out of the thrown value | `5693e9b` | [`apps/web/lib/contract-errors.test.ts`](apps/web/lib/contract-errors.test.ts) — 15 tests, including one asserting *every* known code returns a string, plus malformed-JSON and non-`Error` throw paths |
| #31 — `transfer_handle(handle, new_wallet)` | Atomic key rotation requiring `require_auth` from the current owner, emitting `transferred`; removes the release/re-claim race | `1d8cb3e`, `8190cd9` | `cargo` — `transfer_handle_happy_path`, `transfer_handle_requires_current_owner_auth`, `transfer_handle_unknown_handle_errors`, `transfer_handle_target_wallet_already_bound_errors` |
| #32 — Emit an event from `admin_revoke` | `admin_revoke` publishes an event with the same topic shape as `released`, so the attestation worker no longer silently misses revocations | `1d8cb3e`, `8190cd9` | `cargo` — `admin_revoke_removes_binding` asserts the event is published before any further client call; [`apps/indexer/src/workers/attestation.test.ts`](apps/indexer/src/workers/attestation.test.ts) — `decodeEvent decodes a revoked event` |
| #40 — Counter metrics in the structured logs | Each worker returns its counters; per-record logs demoted to `debug`; one `tick.summary` info line per tick with `walletsScanned`, `eventsDecoded`, `contractsFound`, `opsUpserted`, `snapshotsWritten`, `durationMs` | `d4cf00e` | **Gap** — held only by the typed worker return values and CI `typecheck`. A tick-summary assertion is funded under B7 |
| #45 — Replace the `window.prompt` handle claim with a real form | Inline form with client-side validation mirroring the contract charset, submit disabled while busy, success routed to `/p/{handle}` | `8ba41af` | Partial — [`apps/web/lib/profiles.test.ts`](apps/web/lib/profiles.test.ts) covers `isValidHandle` accept/reject against the registry charset; **no component test** of the form itself. Funded under B7 |
| #47 — `/handles` public directory | Directory built by folding the registry's `claimed`/`released` event stream, with a curated-manifest fallback when the registry is unconfigured | `7b21c17` | [`apps/web/lib/directory.test.ts`](apps/web/lib/directory.test.ts) — 6 tests covering fold correctness, re-claim after release, stable sort, empty state, unconfigured-registry fallback; [`apps/web/e2e/smoke.spec.ts`](apps/web/e2e/smoke.spec.ts) — `handles directory lists the curated handles and links to profiles` |
| #52 — Honest disabled state in the profile editor | `dbConfigured` surfaced through `account.me`; the form is disabled up front with an explanation instead of failing after submit | `f33faf2` | [`apps/web/lib/server/trpc.test.ts`](apps/web/lib/server/trpc.test.ts) — `account.update without a database surfaces a clear error` |
| #54 — Accessibility pass on the nav and claim flow | Visible focus ring, `aria-label` reflecting the current button state, status text announced through a live region, focus-visible styles on nav links | `c4e2a28` | **Gap** — manual review only. An automated accessible-name and focus-order assertion is funded under B7 |
| #69 — CSP entries for optional wallet modules | Required WalletConnect/LOBSTR origins documented as a commented block in `connect-src`, so enabling a Stellar Wallets Kit module does not fail silently | `40ba0ba` | Documentation change; no runtime behaviour to assert |
| #72 — Wasm size budget in the contract CI job | `Wasm size budget` step fails the contracts job when `identity_registry.wasm` exceeds a documented 20 KB `BUDGET_BYTES` (~9 KB today) | `9ef949e` | The CI step **is** the regression guard — [`.github/workflows/ci.yml`](.github/workflows/ci.yml), blocking on every push and PR |
| #73 — `ARCHITECTURE.md` | Both real data flows documented, with an explicit deployed / operational-only split and the config flags that flip between them | `4408d06` | Documentation change; the split it documents is what §1 of this proposal is grounded in |

### Current test coverage

| Suite | Count | Gate |
| --- | --- | --- |
| TypeScript unit tests (web 51 · indexer 6 · sdk 4) | 61 | `pnpm test` in CI |
| Soroban contract tests (`cargo test`) | 18 | contracts job in CI |
| Playwright smoke specs | 7 | opt-in locally; **CI enablement funded under B7** (#71) |

Also gating every push and PR: `lint`, `typecheck`, `build`, the wasm size
budget, and advisory `pnpm audit` / `cargo audit`.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Audit finds a storage or authorization flaw late | Contract features (#33, #34) land **before** the M5 audit freeze; contingency covers a remediation round; mainnet deployment is gated on a clean re-review |
| Public Soroban RPC retains a bounded event window, so a long indexer outage loses history | Paid RPC tier is budgeted (§3.3); the attestation cursor resumes rather than restarts; `--reseed` (#42) rebuilds from a known ledger |
| Handle squatting on a first-come registry | Reserved-handle blocklist (#33) before mainnet; `admin_revoke` exists for abuse, and emits an event (#32) so every moderation action is publicly auditable |
| Single-maintainer bus factor | Contributor onboarding (#70) in M4; all work lands as reviewable PRs against public issues |
| Horizon or RPC provider changes shape | Backoff and retry (#36); the read path degrades to static data rather than erroring, as it already does without `DATABASE_URL` |

---

## 7. Sustainability after the grant

Recurring cost after M5 is the §3.3 infrastructure line — roughly **$225/month**
— not headcount. Three paths, in order of preference:

1. **Reduce the floor.** Once bindings are on-chain, the registry event stream
   is the source of truth and the database becomes a cache. A read path that
   degrades to direct RPC reads (already the `/handles` fallback pattern) makes
   Postgres optional rather than required.
2. **Integrator support.** Organisations embedding "Verified by Signet" at scale
   fund a hosted API tier. The record itself stays free to read.
3. **Ecosystem hosting.** The contract is a public good and the indexer is a
   single container; both are candidates for ecosystem-operated infrastructure.

No path involves charging developers to bind their own identity, and none
involves a token.

---

## 8. Appendix — verifying these claims

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
(cd packages/contracts && cargo test)
```

| Claim | Where to check |
| --- | --- |
| Contract enforces ownership through `require_auth` | [`packages/contracts/identity-registry/src/lib.rs`](packages/contracts/identity-registry/src/lib.rs) |
| 18 contract tests | [`packages/contracts/identity-registry/src/test.rs`](packages/contracts/identity-registry/src/test.rs) |
| Registry is not yet deployed | [`ARCHITECTURE.md`](ARCHITECTURE.md) § *Deployed vs operational-only* |
| Demo data is synthetic | [`README.md`](README.md) § *Live demo*; [`apps/web/public/data/`](apps/web/public/data/) |
| Both data flows are code-complete | [`ARCHITECTURE.md`](ARCHITECTURE.md) § *Flow 1* / *Flow 2* |
| Config flags that flip Phase 2 live | [`.env.example`](.env.example) |
