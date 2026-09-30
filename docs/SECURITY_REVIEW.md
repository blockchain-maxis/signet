# Security review checklist for the new surfaces

The threat model predates most of what is being built now: a spec reader that
downloads and parses **untrusted WASM** from arbitrary contract addresses, a
contract page that renders **attacker-authored doc strings**, a diagram drawn
from untrusted names, a **localhost web UI** served by the CLI, a public
**API**, and **terminal wallet linking**. This document is the one list to
check a PR in epics B, C/D, E, F and H against — and the record of what the
already-shipped linking surface enforces, so a change there can be checked for
regressions rather than re-derived.

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
      streamed bytes so a lying or absent header still cannot exceed the cap.
      `[B: #433]`
- [ ] Custom-section scanning is bounded — a cap on section count and on total
      scanned bytes — so a module built of headers alone cannot pin the
      parser. `[B: #424]`
- [ ] `contractspecv0` decoding has an entry-count cap, a nesting-depth cap
      for `ScSpecTypeDef`, and a wall-clock budget. `[B: #424]`
- [ ] Decode failures are **content, not 500s**: an unreadable interface
      renders as the page states designed in
      [`CONTRACT_DOCS_DESIGN.md`](CONTRACT_DOCS_DESIGN.md) §1.5, using the
      typed failures already defined in
      [`packages/spec/src/errors.ts`](../packages/spec/src/errors.ts)
      (`ContractNotFound`, `NoInterface`, `InterfaceUnreadable`,
      `RpcUnavailable`, `InvalidWasm`). Page-side handling: `[C: #450]`.
- [ ] WASM is never instantiated or executed on the server. This is the
      package contract at the top of
      [`packages/spec/src/index.ts`](../packages/spec/src/index.ts) — a PR
      that adds `WebAssembly.instantiate` (or any VM emulation) to `@signet/spec`
      or `apps/web` is wrong by definition, whatever it is trying to do.

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
      reader's most exposed caller, not an exception to it. `[H: #633]`
