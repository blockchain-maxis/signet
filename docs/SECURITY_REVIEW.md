# Security review checklist for the new surfaces

The threat model predates most of what is being built now: a spec reader that
downloads and parses **untrusted WASM** from arbitrary contract addresses, a
contract page that renders **attacker-authored doc strings**, a diagram drawn
from untrusted names, a **localhost web UI** served by the CLI, a public
**API**, and **terminal wallet linking**. This document is the one list to
check a PR in epics B, C/D, E, F and H against — and the record of what the
already-shipped linking surface and the Identity Registry contract (§7)
enforce, so a change there can be checked for regressions rather than
re-derived.

How to read an item:

- An item that names a file or module is **enforced today**; the reference is
  where. Reviewers of a PR touching that file keep the property true.
- An item tagged `[epic: #issue]` is a requirement on work that **does not
  exist yet**. The PR that implements the referenced issue must land the
  enforcement (and ideally the test) in the same change, then replace the tag
  here with the real reference.

## 1. SSRF and outbound requests

- [ ] No server route accepts a user-supplied RPC, Horizon or explorer URL.
      The network is an enum resolved server-side once, at module load
      (`resolveNetwork` in [`apps/web/lib/network.ts`](../apps/web/lib/network.ts));
      request input never chooses an origin to fetch from.
- [ ] The CSP `connect-src` is not widened by new features. Extra origins come
      only from deployment configuration, through `resolveConnectSources` in
      [`apps/web/lib/csp.ts`](../apps/web/lib/csp.ts) — never from request
      data, and never `*`.
- [ ] Anything that fetches by contract address validates the address shape
      first (`isContractAddress` in
      [`apps/web/lib/contract-address.ts`](../apps/web/lib/contract-address.ts)),
      so a path segment cannot smuggle a URL or a different key type into a
      fetch.

## 2. Untrusted WASM (spec reader, epic B)

The module is attacker-controlled bytes: anyone can deploy a contract and hand
its address to Signet. The reader in `packages/spec` therefore treats size,
count, depth and time as inputs to bound, not properties to trust.

- [ ] A maximum module size is enforced **before** the download completes:
      refuse on Content-Length where the transport provides it, and count
      streamed bytes so a lying or absent header still cannot exceed the cap —
      `maxRpcResponseBytes` / `createBoundedRpcServer` in
      [`packages/spec/src/fetch.ts`](../packages/spec/src/fetch.ts) and the
      256 KB module size guard in `parseContractSpec` in
      [`packages/spec/src/parse.ts`](../packages/spec/src/parse.ts). Proof:
      "fetchContractSpec aborts a streaming RPC response early when bytes exceed
      the size cap" and "fetchContractSpec refuses an oversized Content-Length
      before reading the body" in
      [`packages/spec/src/fetch.test.ts`](../packages/spec/src/fetch.test.ts),
      and `over_size_cap.wasm` in
      [`packages/spec/src/property-fuzz.test.ts`](../packages/spec/src/property-fuzz.test.ts).
- [ ] Custom-section scanning is bounded — a cap on section count (1,024 in
      `readCustomSections` in
      [`packages/spec/src/wasm-sections.ts`](../packages/spec/src/wasm-sections.ts))
      and on total scanned bytes (256 KB in `parseContractSpec` in
      [`packages/spec/src/parse.ts`](../packages/spec/src/parse.ts)) — so a
      module built of headers alone cannot pin the parser. Proof:
      `section_past_end.wasm`, `ten_thousand_sections.wasm`, and the custom
      section boundary regression in
      [`packages/spec/src/property-fuzz.test.ts`](../packages/spec/src/property-fuzz.test.ts).
- [ ] `contractspecv0` decoding has an entry-count cap (1,024 in
      `parseContractSpec` in
      [`packages/spec/src/parse.ts`](../packages/spec/src/parse.ts)), a
      nesting-depth cap for `ScSpecTypeDef` (32 in `assertTypeDepth` /
      `toTypeRef` in
      [`packages/spec/src/type-ref.ts`](../packages/spec/src/type-ref.ts)), and
      a 200 ms wall-clock budget. Proof: `hundred_thousand_entries.wasm`,
      `deep_type_1000.wasm`, `truncated_mid_entry.wasm`, `two_mb_doc.wasm`, and
      the fuzz/cap suites in
      [`packages/spec/src/property-fuzz.test.ts`](../packages/spec/src/property-fuzz.test.ts).
- [ ] Decode failures are **content, not 500s**: an unreadable interface
      renders as the page states designed in
      [`CONTRACT_DOCS_DESIGN.md`](CONTRACT_DOCS_DESIGN.md) §1.5, using the
      typed failures already defined in
      [`packages/spec/src/errors.ts`](../packages/spec/src/errors.ts)
      (`ContractNotFound`, `NoInterface`, `InterfaceUnreadable`,
      `RpcUnavailable`, `InvalidWasm`). Proof: the mutation fuzz property and
      adversarial fixture suite in
      [`packages/spec/src/property-fuzz.test.ts`](../packages/spec/src/property-fuzz.test.ts)
      and failure-kind cases in
      [`packages/spec/src/parse.test.ts`](../packages/spec/src/parse.test.ts).
      Page-side handling: `[C: #450]`.
- [ ] WASM is never instantiated or executed on the server. This is the
      package contract at the top of
      [`packages/spec/src/index.ts`](../packages/spec/src/index.ts) — a PR
      that adds `WebAssembly.instantiate` (or any VM emulation) to `@signet/spec`
      or `apps/web` is wrong by definition, whatever it is trying to do. Proof:
      `readCustomSections` in
      [`packages/spec/src/wasm-sections.ts`](../packages/spec/src/wasm-sections.ts)
      and the isomorphic/no-engine-execution checks in
      [`packages/spec/src/parse.test.ts`](../packages/spec/src/parse.test.ts).

## 3. Rendering attacker-authored content (epics C/D and E)

- [ ] Doc strings render as **plain text** — paragraphs split on blank lines,
      no HTML interpretation — via
      [`apps/web/lib/contract-docs.ts`](../apps/web/lib/contract-docs.ts)
      (D-06). If a later epic chooses Markdown instead, it must be sanitised
      Markdown, and this item updated to name the sanitiser.
- [ ] No `dangerouslySetInnerHTML` anywhere in `apps/web`. There are zero
      occurrences today; a PR that introduces one needs this checklist's
      reviewer to sign off on why nothing else works.
- [ ] Function, type and argument **names** are untrusted too, everywhere they
      appear — headings, anchors, `…/functions#fn-{name}` links — not only doc
      bodies.
- [ ] SVG diagram labels are escaped, and the generated SVG carries no inline
      `<script>` and no `style`/event-handler attributes that would break the
      nonce CSP (the middleware sets the nonce per request in
      [`apps/web/middleware.ts`](../apps/web/middleware.ts)). `[E: #544]`

## 4. Local sandbox (epic F)

- [ ] There is **no hosted execution endpoint** anywhere under
      `apps/web/app/api`. Execution is local-only by design
      ([`CONTRACT_SANDBOX_DESIGN.md`](CONTRACT_SANDBOX_DESIGN.md)); a route
      that accepts WASM, a contract call, or simulator input on the server is
      out of scope for every epic, not a feature request.
- [ ] The localhost UI binds to `127.0.0.1` only — never `0.0.0.0` — and
      defends against DNS rebinding: it checks `Host` and `Origin` on every
      request and requires a per-session token minted at startup. `[F: #579]`
      The `signet dev --ui` server (`cli/internal/devui`, #576), each check
      with the test in `cli/internal/devui/server_test.go` that holds it:
  - [ ] Listens on `127.0.0.1:0` only, no flag for another interface
        (`TestTheServerListensOnLoopbackOnly`).
  - [ ] A 32-byte token per run, only in the URL fragment, sent back as
        `Authorization: Bearer`; no cookies, so no ambient credential
        (`TestEveryRequestIsChecked`: no token, a wrong token and a cookie are
        401).
  - [ ] `Host` exactly `127.0.0.1:<port>` or `localhost:<port>`, against DNS
        rebinding, and a present `Origin` the same (a rebinding host and a
        foreign origin are 403).
  - [ ] No CORS header on any response, and no preflight answered, Private
        Network Access included (`TestAPreflightIsNeverAnswered`).
  - [ ] Static files from one root: `../`, encoded or not, is 404.
  - [ ] Strict CSP (`default-src 'self'`, no inline script), `nosniff`,
        `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on the API.
  - [ ] The token is in no log line: the request log carries method, path
        and status only.
  - [ ] Nothing the UI sends changes the crate path, RPC, network or host
        binary: they come from the command line.
  - [ ] So `signet visualise --open` (#578) can find it, a running session
        writes its URL (token included) to a `0600` file under the user's
        cache directory (`signet/ui/<contract>.json`, directory `0700`) and
        removes it when it stops: readable by the same user only, who can
        already read the process.
- [ ] Forked storage and snapshot files are written only under the project
      directory the developer ran the command in — no writes outside it, and
      fork names are not paths. `[F: #550]`

## 5. CLI wallet linking (shipped — check for regressions)

Each item names the test that proves it; a PR that changes the behaviour
without failing the named test should make the reviewer suspicious of the
test, not comfortable with the change.

- [ ] Every `/api/cli/*` route fails **closed** without a database (#349):
      `getStore()` returning null becomes a 503, never a silent success —
      [`apps/web/lib/server/pairing.ts`](../apps/web/lib/server/pairing.ts),
      [`apps/web/lib/server/cli-unlink.ts`](../apps/web/lib/server/cli-unlink.ts).
      Proof: the `unavailable` cases in
      [`apps/web/lib/server/pairing.test.ts`](../apps/web/lib/server/pairing.test.ts)
      and [`apps/web/lib/server/cli-unlink.test.ts`](../apps/web/lib/server/cli-unlink.test.ts).
- [ ] Every `/api/cli/*` route has a `LIMITS` bucket
      ([`apps/web/lib/rate-limit-policy.ts`](../apps/web/lib/rate-limit-policy.ts):
      `cliPairStart`, `cliPairComplete`, `cliPairStatus`, `cliLink`, …) and
      calls `enforceRateLimit` before doing anything else.
- [ ] Bearer credentials are stored **only as hashes**: `pollTokenHash` and
      `handoffHash` on `PairingState`
      ([`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma)).
      A new pairing credential follows the same rule — the clear value is
      returned exactly once and never written. Proof: "returns a poll token
      that is not the pairing code" in `pairing.test.ts`.
- [ ] A pairing only moves **forward**: pending → approved → completed, or
      rejected — every transition is a conditional `updateMany` on the
      expected prior status, so concurrent calls cannot both win. Proof: the
      `already-used` / `already-completed` cases in `pairing.test.ts`.
- [ ] Completing requires **both** proofs: the browser session approved
      (handle ownership) and a SEP-10 challenge signed by the declared deploy
      key (key control), with the challenge spent exactly once
      ([`apps/web/lib/server/challenge-spend.ts`](../apps/web/lib/server/challenge-spend.ts)).
      Proof: the adversarial section of `pairing.test.ts` (#291) — foreign
      server, foreign domain, replay, never-approved, wrong key.
- [ ] The CLI's loopback callback verifies `state` (#328): `MatchState` in
      [`cli/internal/loopback/loopback.go`](../cli/internal/loopback/loopback.go),
      proved by `cli/internal/loopback/loopback_test.go` and the mismatched-state
      case in `cli/internal/link/flow_test.go`. The callback is also
      origin-restricted to the deployment being linked
      ([`cli/internal/cmd/link.go`](../cli/internal/cmd/link.go)).
- [ ] Mutating browser-facing routes check `isSameOrigin`
      ([`apps/web/lib/security.ts`](../apps/web/lib/security.ts)) — approve
      and reject are consent, and consent must not be forgeable cross-origin.
- [ ] `/link` discloses nothing to the signed-out or the merely curious:
      session first, then the pairing; `describePairing` never returns
      `profileId`. Proof: "never discloses which profile approved" in
      `pairing.test.ts`.

## 6. Public API (epic H)

- [ ] Every `/api/v1/*` route has a rate-limit bucket, like the CLI routes
      above. `[H: #624]`
- [ ] The CORS policy is stated explicitly in the design, not left to
      defaults. `[H: #624]`
- [ ] No response field reveals a wallet's non-primary links unless the
      profile already shows them publicly — the API must not become a reverse
      index the profile page refuses to be. `[H: #633]`
- [ ] Spec-serving endpoints inherit every bound in §2 — the API is the spec
      reader's most exposed caller, not an exception to it. The public routes in
      `apps/web/lib/api/v1/contract-spec.ts` validate inputs before RPC and use
      `fetchWasmHash` / `fetchContractSpecByHash` from `packages/spec/src/fetch.ts`,
      including its bounded transport, deadline, parser limits and hash check.
      They never consult the optional registry fallback or attribution database.
      Proof: the by-hash tests in `packages/spec/src/fetch.test.ts` and the
      offline route tests in `apps/web/lib/api/v1/contract-spec.test.ts`.

## 7. Identity Registry contract

[`packages/contracts/identity-registry/src/lib.rs`](../packages/contracts/identity-registry/src/lib.rs)
is the most security-critical code in the repo. The deployed wasm is
**immutable**: a defect cannot be patched, only recovered by deploying a new
contract and migrating
([`CONTRACT_MIGRATION.md`](CONTRACT_MIGRATION.md)), and a third-party audit is
a hard gate before mainnet
([`DEPLOYMENT.md` §10](DEPLOYMENT.md#10-going-to-mainnet)). A PR touching
`lib.rs` keeps every property below true. Test names refer to
[`src/test.rs`](../packages/contracts/identity-registry/src/test.rs) unless
another file is named. The contract in `main` can be ahead of the deployed
wasm; which methods are live is in
[`REGISTRY_INTEGRATION.md` §2](REGISTRY_INTEGRATION.md#2-interface).

### Auth matrix

- [ ] Every entry point requires exactly the signer below, checked with
      `require_auth` on the address named. A new entry point gets a row here
      and a test that it fails without that signature.

| Entry point | Must sign | Proof |
|---|---|---|
| `initialize(admin)` | `admin` | `initialize_requires_admin_auth`; one-time: `initialize_is_one_time` |
| `set_admin(new_admin)` | current admin | `set_admin_requires_current_admin_auth`, `set_admin_rotates_authority`, `set_admin_before_initialize_errors` |
| `claim(handle, wallet)` | `wallet` | `claim_requires_wallet_auth`, `claim_before_initialize_errors` |
| `release(handle)` | the handle's current owner (resolved on-chain, not passed in) | `release_requires_owner_auth`, `release_rejected_when_authorized_by_wrong_address` |
| `transfer_handle(handle, new_wallet)` | current owner (see the `#978` item below) | `transfer_handle_requires_current_owner_auth` |
| `admin_revoke(handle)` | admin | `admin_revoke_requires_admin_auth`, `admin_revoke_rejected_when_authorized_by_wrong_address` |
| `resolve`, `lookup`, `is_bound`, `count`, `resolve_batch` | nobody (reads) | no `require_auth` in those functions |

- [ ] `transfer_handle` must also require `new_wallet`'s signature, so a handle
      cannot be pushed onto a wallet that never agreed to it. Today only the
      current owner signs. `[registry: #978]`
- [ ] Ownership checks authorize the **resolved** owner, never a caller-supplied
      address: `release` and `transfer_handle` call `resolve` and then
      `require_auth` on its result. A non-owner therefore fails with an auth
      error, not `NotOwner`
      ([`REGISTRY_INTEGRATION.md` §3](REGISTRY_INTEGRATION.md#3-errors)).

### Admin powers

- [ ] The admin can do exactly two things: `admin_revoke` (force-remove a
      binding) and `set_admin` (rotate the admin key). The admin **cannot
      create or redirect a binding**. Every write to `DataKey::Owner` /
      `DataKey::Handle` is reached only through `claim` (signed by the wallet),
      `transfer_handle` (signed by the owner) or `remove_binding`, which only
      deletes. A compromised admin can censor but never impersonate
      ([`identity-registry/README.md`](../packages/contracts/identity-registry/README.md#trust-model)).
- [ ] The migration-only `admin_reserve` / `seal` entry points narrow **who may
      claim** a reserved handle and never assign one. `admin_reserve` writes a
      reservation, not a binding, and the reserved wallet still signs its own
      `claim`. `seal` is one-way and turns the power off for good, so the extra
      admin power is temporary
      ([`CONTRACT_MIGRATION.md` §4](CONTRACT_MIGRATION.md#4-the-replacement-contract)).
      `[registry: #982]`
- [ ] There is no upgrade entry point (no `update_current_contract_wasm`
      anywhere in `lib.rs`). Adding one is a change to the trust model, not a
      feature, and needs its own design review.

### Handle rules

- [ ] Handles are 1–32 bytes of `[a-z0-9_-]` (uppercase rejected), enforced by
      `validate_handle` in `lib.rs` (`MAX_HANDLE_LEN`). Proof:
      `claim_rejects_invalid_handles`, `valid_handle_charset_is_accepted`, and
      in [`src/property_test.rs`](../packages/contracts/identity-registry/src/property_test.rs)
      `validate_handle_matches_the_spec_on_arbitrary_bytes`,
      `validate_handle_rejects_non_ascii_text`,
      `validate_handle_length_bound_is_inclusive_at_32` and
      `claim_rejects_exactly_the_handles_validation_rejects`.
- [ ] Reserved names (`RESERVED_HANDLES`) are refused by `is_reserved_handle`
      in `claim`, as an exact match and not a prefix match. Proof:
      `claim_rejects_reserved_handles`,
      `claim_allows_handles_that_only_resemble_reserved_names`.
- [ ] The off-chain mirror stays identical: `HANDLE_MAX_LEN`,
      `HANDLE_PATTERN` and `RESERVED_HANDLES` in
      [`packages/types/src/handle.ts`](../packages/types/src/handle.ts) are
      parsed against `lib.rs` by
      [`packages/types/src/handle.test.ts`](../packages/types/src/handle.test.ts)
      ("HANDLE_MAX_LEN matches MAX_HANDLE_LEN in the contract", "RESERVED_HANDLES
      matches the contract list exactly", "the contract enforces the same
      charset this module encodes"). Change both sides in the same PR.

### Storage and TTL

- [ ] `DataKey::Admin` and `DataKey::Count` live in **instance** storage, and
      `DataKey::Owner(handle)` / `DataKey::Handle(wallet)` in **persistent**
      storage. Both directions of a binding are written, extended and removed
      together (`claim`, `transfer_handle`, `remove_binding`). Proof:
      `release_frees_handle_and_wallet`, `transfer_handle_happy_path`.
- [ ] Every entry point calls `bump_instance`, reads included. If the instance
      archives, `require_initialized` fails and every state-changing call
      reverts until someone restores it, so the registry looks bricked while
      its bindings are still alive (`bump_instance`'s doc comment in
      `lib.rs`). Proof: `every_read_keeps_the_instance_alive`,
      `a_missed_read_still_keeps_the_instance_alive`.
- [ ] **Simulated reads extend nothing.** A simulation discards its
      footprint, so a deployment whose traffic is all view-simulations still
      needs the operator keep-alive
      ([`DEPLOYMENT.md` §11](DEPLOYMENT.md#11-keeping-the-instance-alive-and-restoring-it-after-archival)).
      Do not argue that "reads bump the instance" makes the keep-alive
      optional.

### Counter semantics

- [ ] `count()` is an O(1) **upper bound**, not a live total. A binding whose
      persistent entries archive unaccessed runs no contract code, so nothing
      subtracts it, and the counter only drifts upward (`count`'s doc comment
      in `lib.rs`). No consumer, doc or UI may present it as "currently bound",
      and only `resolve` proves a binding is live. `remove_binding` uses
      `saturating_sub`. Proof: `count_tracks_active_bindings`,
      `count_never_underflows`, and
      `count_equals_live_bindings_after_any_sequence` in `src/property_test.rs`
      (exact there only because nothing archives in the test host).

### Events are an API

- [ ] The event layout is a public interface that the indexer
      ([`apps/indexer/src/workers/attestation.ts`](../apps/indexer/src/workers/attestation.ts)),
      `/handles` ([`apps/web/lib/directory.ts`](../apps/web/lib/directory.ts))
      and third-party integrators fold
      ([`REGISTRY_INTEGRATION.md` §4](REGISTRY_INTEGRATION.md#4-events)).
      Binding events are topics `(Symbol(kind), String(handle))`:
      `claimed` / `released` / `revoked` carry `address(wallet)`, and
      `transferred` carries `(from, to)`. `admin_changed` has the one-element
      topic `(Symbol("admin_changed"),)` with `(old_admin, new_admin)`, and
      `initialize` publishes nothing. Each write emits exactly one event, and
      the tests pin its exact topics and data (#980): `claim_emits_event`,
      `release_emits_event`, `admin_revoke_emits_event`,
      `transfer_handle_emits_event`, `set_admin_emits_event`,
      `initialize_publishes_no_events`. Changing a topic, the order of a tuple
      or a data shape breaks every consumer of the deployed registry. Add a
      new kind rather than reshaping an old one.

### Error codes

- [ ] The `Error` enum is **append-only**. Integrators match on the number
      (`Error(Contract, #N)`), and an immutable deployment keeps the old
      numbering forever. Never renumber, rename or remove a variant. Add the
      next free code instead.
      [`scripts/check-contract-errors.mjs`](../scripts/check-contract-errors.mjs)
      (CI `docs` job) fails if a code in its `FROZEN_CODES` list changes number
      or name, if a new code is not appended there, or if
      [`apps/web/lib/contract-errors.ts`](../apps/web/lib/contract-errors.ts)
      drifts from the enum.
