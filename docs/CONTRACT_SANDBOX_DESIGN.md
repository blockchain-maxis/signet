# Design: contract sandbox

**Status:** design note. Nothing here is built yet, and per the roadmap item this
follows terminal linking rather than preceding it. The note exists so the shape
is settled before then — and because investigating it turned up something that
changes what should be built.

A profile proves _what_ a developer deployed. The sandbox lets a visitor find
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
is true of _some_ of what a sandbox does. It is not true of most of it, and the
difference is worth a lot of engineering.

**Soroban RPC's `simulateTransaction` already executes a deployed contract's
functions, against real ledger state, with no wallet and no funded account.**

Verified, with a `Keypair.random()` that has never existed on any ledger as the
transaction source:

| Call                                               | Result                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `count()` — read-only                              | Executed. Returned `2` — the real number of bindings in the registry, at ledger 4421491.                   |
| `claim(handle, wallet)` — mutating, `require_auth` | Simulated with **no error** and returned **1 auth entry** describing the signature that would be required. |

That second row is the surprising one. A state-mutating, authorisation-gated
function simulates cleanly without a signature, and the response says exactly
what authorisation the real call would need. A visitor can be shown what a write
_would_ do and what it would ask them to sign, having signed nothing.

So the sandbox's headline requirement — run a deployed contract's functions with
no wallet, no testnet account, no local toolchain — is satisfied today by an
RPC endpoint and the SDK already in `apps/web`.

### 1.1 What RPC simulation genuinely cannot do

The embedded host is not unnecessary; it is _narrower_ than the roadmap item
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

### 1.2 Therefore: local execution only

Execution is local through the `signet` CLI and never hosted. The isolation problem largely dissolves: the developer already chose to run the CLI, and `soroban-env-host` is a metered interpreter with no ambient filesystem or network authority, so the untrusted WASM is confined by the host's own budget on the user's machine.

**Considered and rejected:** A Signet-hosted simulate route. Hosting execution would mean running arbitrary attacker-supplied WASM, seeded with arbitrary attacker-supplied state, on Signet's infrastructure, on demand, for anyone. Doing that safely means a sandbox per invocation with CPU, memory and wall-clock caps, no network, no filesystem, and a resource-exhaustion story — a permanent operational liability for a project whose other components are a Next.js app and an indexer worker.

---

## 2. Where execution runs

### 2.1 Local, in the `signet` CLI

As established in §1.2, execution runs locally in the CLI. This lands the heavy dependency where a Rust component already lives: behind the CLI's bridge, shipped in the release matrix.

### 2.2 The Go ↔ Rust boundary

The CLI and the Rust simulator cross a boundary defined in [`CLI_RUST_BRIDGE.md`](CLI_RUST_BRIDGE.md). That note settled the boundary: the CLI spawns a long-lived Rust subprocess speaking newline-delimited JSON (NDJSON) over stdio, with no cgo. The schema includes versioning, correlation IDs, and strict error/timeout contracts. The sandbox's request carries seeded ledger entries and a protocol version alongside the invocation.

---

## 3. Seeding contract state

### 3.1 The fork model

An empty ledger is the wrong default because almost every interesting question is about a contract _as it is_. The sandbox starts from the real ledger and allows modifications.

1. **Lazy RPC-backed fetch (default)** — The sandbox pins to a fork ledger and lazily fetches entries via RPC as the contract demands them. This includes drift detection to ensure the state remains consistent with the pinned ledger.
2. **Archive checkpoint (opt-in)** — A complete state dump via `stellar snapshot create`. This is slow but strictly consistent and reproducible offline. (A measured observation of this approach took 3m27s and then failed, illustrating why it is opt-in rather than the default).
3. **Overlay** — Edit a specific entry's value before running. The spec reader (§7) already knows each entry's type, so this is a typed form, not raw XDR.

### 3.2 Footguns to close by construction

- **A seeded run must never be mistakable for a real one.** Every result carries its provenance: which ledger it started from and which entries were modified.
- **Seeding is local-only.** Accepting attacker-authored ledger state on a server is why execution is local; allowing it to be uploaded would reintroduce that risk.
- **Snapshot at a pinned ledger, not "latest".** Otherwise re-running the same scenario a minute later can produce a different answer with nothing in the session to explain it.

---

## 4. Protocol versions

### 4.1 Host lanes and supported protocols

Host lanes are keyed on the network ledger protocol, not on the contract's `contractenvmetav0`. In `soroban-env-host` 28.0.2, `Host::check_ledger_protocol_supported` (`src/host.rs`) compares the ledger's protocol against the host's own interface version and rejects both directions (the "too old" arm is compiled out under `test` and the `next` feature):

```rust
let proto = self.get_ledger_protocol_version()?;
#[cfg(not(any(test, feature = "next")))]
if proto < meta::INTERFACE_VERSION.protocol {
    return Err(/* "ledger protocol version too old for host" */);
}
if proto > meta::INTERFACE_VERSION.protocol {
    return Err(/* "ledger protocol version too new for host" */);
}
```

A host build therefore serves exactly one network protocol, which is why the sandbox carries one host per lane. The contract's env meta must be ≤ the lane's protocol.

The policy for the sandbox is:

- **Support a window of the current plus previous protocol.** A contract deployed under a recent protocol must still run.
- **Read the target from the contract.** The contract states its protocol in `contractenvmetav0`. Default to it; allow an override for someone deliberately testing across a bump.
- **Refuse loudly, never silently.** A contract outside the supported window gets "this contract targets protocol N; this build supports N…M". A wrong answer here is worse than no answer.
- **Treat the window as a maintenance obligation.** The range needs a CI check that compares it against the live network protocol and fails when the network moves past it.

---

## 5. `signet dev`

The `signet dev` command provides an interactive development environment:

- **Swap-keeping-storage**: Allows hot-swapping the contract WASM while preserving the seeded storage entries, enabling rapid iteration on logic without resetting state.
- **Replay**: Deterministically replay a saved scenario or transaction against the current or new WASM.
- **Diff**: Visually diff the state changes (ledger entries modified, created, or deleted) resulting from an invocation.

---

## 6. Local UI threat model and CAP-85/CAP-86

Since execution is local, the threat model shifts from infrastructure abuse to user exploitation. A malicious contract or scenario file could attempt to deceive the user via the local UI.

- The UI must clearly delineate between simulated outcomes and actual network state.
- **CAP-85/CAP-86 implications**: The sandbox must accurately simulate Soroban's authorization framework. Preflight simulations and auth entry rendering must match what the network will enforce, ensuring the user understands what signatures are genuinely required.

---

## 7. Reuse of the spec extraction

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
- **`build`** — `contractmetav0` provenance, and the protocol target §4.1 keys
  the host version on.

This is why auto-docs should ship first: it builds and proves the reader against
a real contract, and the sandbox then spends its whole budget on execution —
the only part that is uniquely its problem.

**One reader, not two.** Two parsers means two answers to "what does this
contract expose", and the wrong one will not announce itself. If the sandbox
needs a spec arm the flattened views omit, it reaches for `entries` — which the
interface exposes for exactly this — rather than decoding again.

---

## 8. Rendering results for a non-developer

The audience is someone evaluating a developer's work, not the contract's
author. That constrains every rendering choice.

### 8.1 Say what happened, in the contract's own words

- **Return values as native types**, via `scValToNative` — `2`, not
  `ScVal(U32(2))`.
- **Errors by name**, from the error enum — `HandleTaken`, with its doc comment,
  not `Error(Contract, #3)`. The name is meaningful; the number is not, and it
  is the single largest legibility win available.
- **Events decoded** with the same spec, as topic-plus-data pairs rather than
  raw XDR.
- **Raw XDR available but folded away.** A developer will want it; it must not
  be the first thing a non-developer sees.

### 8.2 Distinguish the three things a "successful" call can mean

This is the part a naive renderer gets wrong. All three come back as an
untroubled response, and they mean entirely different things:

| Outcome                    | What it means                                            | How it must read                                                               |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Read returned a value      | The function ran and produced this                       | The value, plainly                                                             |
| Write simulated cleanly    | This _would_ succeed, and would require these signatures | Framed as a preview, with the auth entries named — nothing was submitted       |
| Contract returned an error | The function ran and deliberately rejected               | The error name and doc — this is the contract working, not the sandbox failing |

The middle row is the one the verified `claim` transcript exposes: a mutating
function simulated without error and returned one auth entry. Rendering that as
"success" would tell a visitor a handle was claimed. **Nothing was submitted;
the UI must never suggest otherwise.**

### 8.3 State what it ran against

Every result carries: the network, the ledger it ran against, and
whether state was seeded and which entries were modified. Without it, a sandbox
result is an assertion with no provenance, which is precisely what Signet exists
not to publish.

---

## 9. Sequencing

_(Superseded by this epic's order; the bridge specification is done. The user guide is tracked in #642.)_

---

## Open questions

- **Where does the sandbox live in the UI?** Alongside the generated docs on
  `/p/{handle}/contract/{address}` is the obvious answer — same contract, same
  spec, one page. But docs are static-rendered and cacheable while the sandbox
  is interactive and rate-limited, so they may not want to share a route.
- **How much simulation does a public page absorb before it needs an account?**
  Rate limiting bounds abuse but also bounds legitimate exploration. Unknown
  until there is traffic.
- **Is a shareable sandbox result worth building?** A link reproducing a
  function, its inputs and its result would be a good way to show work on a
  profile — and immediately raises whether a _seeded_ result should be shareable
  at all, given §3.2.
