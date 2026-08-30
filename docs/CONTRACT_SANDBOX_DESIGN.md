# Design: contract sandbox

**Status:** design note. Nothing here is built yet, and per the roadmap item this
follows terminal linking rather than preceding it. The note exists so the shape
is settled before then — and because investigating it turned up something that
changes what should be built.

A profile proves *what* a developer deployed. The sandbox lets a visitor find
out what those contracts actually **do**: pick a function, supply inputs, see the
outputs and events — with no wallet, no testnet account, and no local toolchain.

> Every claim in §1 was verified against the deployed Identity Registry
> (`CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`) on Stellar
> testnet, using the `@stellar/stellar-sdk` this repo already pins. The
> transcripts are what the sections below are reasoning about.

---

## 1. The finding that reframes this

The roadmap item states that the sandbox "must execute Soroban semantics rather
than read them, so it needs `soroban-env-host` in Rust behind the bridge." That
is true of *some* of what a sandbox does. It is not true of most of it, and the
difference is worth a lot of engineering.

**Soroban RPC's `simulateTransaction` already executes a deployed contract's
functions, against real ledger state, with no wallet and no funded account.**

Verified, with a `Keypair.random()` that has never existed on any ledger as the
transaction source:

| Call | Result |
| ---- | ------ |
| `count()` — read-only | Executed. Returned `2` — the real number of bindings in the registry, at ledger 4421491. |
| `claim(handle, wallet)` — mutating, `require_auth` | Simulated with **no error** and returned **1 auth entry** describing the signature that would be required. |

That second row is the surprising one. A state-mutating, authorisation-gated
function simulates cleanly without a signature, and the response says exactly
what authorisation the real call would need. A visitor can be shown what a write
*would* do and what it would ask them to sign, having signed nothing.

So the sandbox's headline requirement — run a deployed contract's functions with
no wallet, no testnet account, no local toolchain — is satisfied today by an
RPC endpoint and the SDK already in `apps/web`.

### 1.1 What RPC simulation genuinely cannot do

The embedded host is not unnecessary; it is *narrower* than the roadmap item
assumed. Simulation runs against **the network's current ledger, at the
network's current protocol, inside the network's resource limits**. It therefore
cannot:

- **Seed hypothetical state.** "What does `release` do when the handle is bound
  to someone else?" needs a ledger that does not exist. Simulation can only ask
  about the one that does.
- **Run a protocol version other than the network's.** Testnet is on protocol
  **28** today. The registry was built against protocol **26** (from its own
  `contractenvmetav0`). A contract archived before a protocol bump, or one a
  reader wants to compare across versions, is out of reach.
- **Exceed network resource limits**, or report a budget other than the
  network's.
- **Run offline or deterministically.** Simulation depends on a live RPC node
  and on ledger state that changes underneath it, so the same request is not
  guaranteed the same answer twice.
- **Chain calls with state carried between them.** Each simulation starts from
  current ledger state; a two-step scenario cannot apply step one before step
  two.

### 1.2 Therefore: two phases

**Phase 1 — RPC simulation.** Ships without Rust, without the bridge, and
without waiting for terminal linking. Covers every read-only function, and
previews every write including the authorisation it would demand. This is the
bulk of the product value described in the roadmap item.

**Phase 2 — embedded `soroban-env-host`.** Adds exactly the five capabilities
above, and only those. It is a strictly larger sandbox in the same UI, not a
different feature.

Deciding this now matters because the phases have very different costs. Phase 1
is a form, a simulate call, and a result renderer. Phase 2 is a Rust crate, a
subprocess bridge, a release matrix carrying a second binary, and a protocol
support policy. Building phase 2 first — as "the sandbox needs
`soroban-env-host`" implies — spends all of that before anyone has used a
sandbox at all.

---

## 2. Where execution runs

### 2.1 Phase 1: the Signet server, not the browser

Simulation needs an RPC endpoint. Calling it from the browser would expose
whichever endpoint we use to unmetered public traffic and hand every visitor's
IP to that provider. So the sandbox posts to a Signet route that simulates
server-side, exactly as `apps/web/lib/server/registry-read.ts` already does for
resolution.

There is no isolation problem to solve. The server is not executing anything:
it builds a transaction envelope, posts it to an RPC node, and renders the
reply. The untrusted code runs on the RPC provider's infrastructure, inside
limits they already enforce.

What it does need:

- **Rate limiting**, reusing the existing limiter. Simulation is
  cheap-but-not-free and a public form is an obvious abuse surface.
- **A per-request timeout** below the route's, so a slow node is a message
  rather than a hung page.
- **No user-supplied RPC URL.** An endpoint field would turn the route into an
  SSRF proxy against the deployment's network position. The network is chosen
  from the same config the rest of the app uses.

### 2.2 Phase 2: CLI-local, not hosted

Once real execution is involved the question becomes serious, and the answer is
**local, in the `signet` CLI** — not on Signet's servers.

Hosting it would mean running arbitrary attacker-supplied WASM, seeded with
arbitrary attacker-supplied state, on Signet's infrastructure, on demand, for
anyone. Doing that safely means a sandbox per invocation with CPU, memory and
wall-clock caps, no network, no filesystem, and a resource-exhaustion story —
a piece of infrastructure substantially larger than the feature it serves, and
a permanent operational liability for a project whose other components are a
Next.js app and an indexer worker.

Locally, the isolation problem largely dissolves. The developer already chose to
run the CLI; `soroban-env-host` is a metered interpreter with no ambient
filesystem or network authority, so the untrusted WASM is confined by the host's
own budget. What remains is bounding the budget so a pathological contract
cannot wedge the terminal.

This also lands the heavy dependency where the roadmap already puts a Rust
component: behind the CLI's bridge, shipped in the release matrix, not in a
serverless function.

**Consequence, stated plainly:** phase 2 is not available to a visitor reading a
profile in a browser. That is the honest trade. A visitor gets phase 1 — real
execution against real state, which is what they came for. Seeded scenarios and
cross-protocol replay are a developer tool, and developers can install a CLI.

### 2.3 The boundary is not this note's to define

Phase 2 crosses the Go ↔ Rust boundary that issue #298 exists to specify:
subprocess, JSON over stdio, no cgo, a versioned request/response schema, the
error and timeout contract, and how the two binaries ship and detect a version
mismatch. This note must not re-decide any of that. It supplies a requirement
into it: the sandbox's request carries **seeded ledger entries and a protocol
version** alongside the invocation, so whatever schema #298 fixes needs room for
both.

---

## 3. Seeding contract state

Phase 1 does not seed anything — it runs against current ledger state, and the
UI says so. Everything here is phase 2.

### 3.1 Start from the real ledger, then overlay

The default is a **snapshot of real state at a chosen ledger**, with an optional
overlay of modified entries. Not an empty ledger.

An empty ledger is the wrong default because almost every interesting question
is about a contract *as it is*. "What does `release` do for a handle I don't
own" starts from a registry that already has bindings. Making the visitor
reconstruct that state before asking anything turns a question into a chore, and
the reconstruction can be wrong in ways that quietly invalidate the answer.

Three sources, in order of how much the user has to know:

1. **Live snapshot** (default) — fetch the contract instance, its WASM, and the
   entries the invocation touches. Requires nothing from the user.
2. **Overlay** — edit a specific entry's value before running. The spec reader
   (§5) already knows each entry's type, so this is a typed form, not raw XDR.
3. **Scenario file** — a serialised set of entries the CLI can save and replay.
   This is what makes a sandbox session reproducible and shareable, and what
   turns it into a regression check a developer can keep.

### 3.2 Footguns to close by construction

- **A seeded run must never be mistakable for a real one.** Every result carries
  its provenance: which ledger it started from and which entries were modified.
  The profile page already draws this line for demo versus on-chain data; the
  same discipline applies, for the same reason.
- **Seeding is local-only.** Accepting attacker-authored ledger state on a
  server is half of why §2.2 chose local execution; allowing it to be uploaded
  would reintroduce exactly that.
- **Snapshot at a pinned ledger, not "latest".** Otherwise re-running the same
  scenario a minute later can produce a different answer with nothing in the
  session to explain it.

---

## 4. Protocol versions

### 4.1 Phase 1 has no policy, and that is the point

Simulation runs on the network's node at the network's protocol. Whatever
testnet or mainnet is running is what executes. Nothing to pin, nothing to
support, nothing to fall behind.

### 4.2 Phase 2 needs a policy, and the reference implementation is a warning

`erst`'s `simulator/` crate pins `soroban-env-host >=21, <26` so one binary
spans protocol versions, and the roadmap item cites it as the model. The
approach is right; the specific pin is a cautionary tale.

Measured today:

- Stellar testnet: protocol **28**.
- The Identity Registry's `contractenvmetav0`: built against protocol **26**.

A `>=21, <26` simulator **cannot execute either** — not the current network, and
not Signet's own contract. A range chosen when it was current has been overtaken
twice.

So the policy is not "copy erst's range". It is:

- **Support the current network protocol and a defined window behind it.** A
  contract deployed under protocol 26 and never touched since must still run;
  that is a large fraction of what a profile links to.
- **Read the target from the contract, not from a flag.** The contract states
  its protocol in `contractenvmetav0` — the same section the spec reader already
  parses. Default to it; allow an override for someone deliberately testing
  across a bump.
- **Refuse loudly, never silently.** A contract outside the supported window
  gets "this contract targets protocol N; this build supports N…M", not a
  plausible-looking result from the wrong host version. A wrong answer here is
  worse than no answer, because nothing about it looks wrong.
- **Treat the window as a maintenance obligation with a visible expiry.** The
  pin above did not fail loudly; it just quietly stopped covering the network.
  Whatever range is chosen needs a CI check that compares it against the live
  network protocol and fails when the network moves past it.

---

## 5. Reuse of the spec extraction

The sandbox does not read contract interfaces itself. It consumes the shared
reader specified in [`CONTRACT_DOCS_DESIGN.md`](CONTRACT_DOCS_DESIGN.md) §5,
which auto-docs builds first:

```ts
fetchContractSpec(address, network) → ContractSpec
```

Everything the sandbox needs to render a form and interpret a result is already
on that object, and was verified to exist:

- **`functions`** — the callable list, with doc comments, to populate the picker.
- **`spec.jsonSchema(name)`** — a JSON Schema of a function's arguments,
  produced by the SDK. This is the input form, derived rather than hand-written.
- **`spec.nativeToScVal` / `scValToNative`** — marshalling in both directions.
- **`errors`** — the `contracterror` enum, so a failure renders as
  `HandleTaken`, not `Error(Contract, #3)`.
- **`build`** — `contractmetav0` provenance, and the protocol target §4.2 keys
  the host version on.

This is why auto-docs should ship first: it builds and proves the reader against
a real contract, and the sandbox then spends its whole budget on execution —
the only part that is uniquely its problem.

**One reader, not two.** Two parsers means two answers to "what does this
contract expose", and the wrong one will not announce itself. If the sandbox
needs a spec arm the flattened views omit, it reaches for `entries` — which the
interface exposes for exactly this — rather than decoding again.

---

## 6. Rendering results for a non-developer

The audience is someone evaluating a developer's work, not the contract's
author. That constrains every rendering choice.

### 6.1 Say what happened, in the contract's own words

- **Return values as native types**, via `scValToNative` — `2`, not
  `ScVal(U32(2))`.
- **Errors by name**, from the error enum — `HandleTaken`, with its doc comment,
  not `Error(Contract, #3)`. The name is meaningful; the number is not, and it
  is the single largest legibility win available.
- **Events decoded** with the same spec, as topic-plus-data pairs rather than
  raw XDR.
- **Raw XDR available but folded away.** A developer will want it; it must not
  be the first thing a non-developer sees.

### 6.2 Distinguish the three things a "successful" call can mean

This is the part a naive renderer gets wrong. All three come back as an
untroubled response, and they mean entirely different things:

| Outcome | What it means | How it must read |
| ------- | ------------- | ---------------- |
| Read returned a value | The function ran and produced this | The value, plainly |
| Write simulated cleanly | This *would* succeed, and would require these signatures | Framed as a preview, with the auth entries named — nothing was submitted |
| Contract returned an error | The function ran and deliberately rejected | The error name and doc — this is the contract working, not the sandbox failing |

The middle row is the one the verified `claim` transcript exposes: a mutating
function simulated without error and returned one auth entry. Rendering that as
"success" would tell a visitor a handle was claimed. **Nothing was submitted;
the UI must never suggest otherwise.**

### 6.3 State what it ran against

Every result carries: the network, the ledger it ran against, and — in phase 2 —
whether state was seeded and which entries were modified. Without it, a sandbox
result is an assertion with no provenance, which is precisely what Signet exists
not to publish.

---

## 7. Sequencing

1. **Auto-docs** ([`CONTRACT_DOCS_DESIGN.md`](CONTRACT_DOCS_DESIGN.md)) — builds
   the shared spec reader. No Rust, no bridge, no dependency on linking.
2. **Sandbox phase 1** — RPC simulation over that reader. Still no Rust. This is
   the roadmap item's headline promise, deliverable without the bridge.
3. **Bridge specification** (#298) — the Go ↔ Rust boundary, with room in the
   schema for seeded entries and a protocol target.
4. **Sandbox phase 2** — the embedded host in the CLI, for seeded state and
   cross-protocol replay.

Terminal linking gates step 4, because that is where a Rust component and the
CLI that carries it first appear. It does not gate steps 1 and 2, and the
roadmap item's "not started before it ships" should be read as applying to the
Rust work rather than to the whole feature.

---

## Open questions

- **Should phase 1 offer write previews at all?** The auth-entry output is
  genuinely informative, but "this would work" one click from a Connect Wallet
  button invites a visitor to submit something they have not understood.
  Possibly reads-only until the framing is tested on someone who is not a
  developer.
- **Where does the sandbox live in the UI?** Alongside the generated docs on
  `/p/{handle}/contract/{address}` is the obvious answer — same contract, same
  spec, one page. But docs are static-rendered and cacheable while the sandbox
  is interactive and rate-limited, so they may not want to share a route.
- **How much simulation does a public page absorb before it needs an account?**
  Rate limiting bounds abuse but also bounds legitimate exploration. Unknown
  until there is traffic.
- **Is a shareable sandbox result worth building?** A link reproducing a
  function, its inputs and its result would be a good way to show work on a
  profile — and immediately raises whether a *seeded* result should be shareable
  at all, given §3.2.
