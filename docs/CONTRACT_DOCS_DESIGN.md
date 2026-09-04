# Design: contract documentation generated from the on-chain spec

**Status:** design note. Nothing here is built yet — this document exists to
decide the shape before code, and to hand the sandbox and visualiser roadmap
items a spec reader they can share rather than each writing their own.

Every Soroban contract carries its own interface inside the deployed WASM. Given
a contract address and an RPC endpoint, that is enough to produce accurate
reference documentation with no input from the contract's author — and it cannot
drift from the deployed code, because it is derived from it.

This matters for Signet specifically. A profile currently proves _what_ an
address deployed. Most of those contracts have no documentation anywhere, so to
a reader evaluating a developer's work the profile is a list of `C…` strings.
Generated docs are what turn that list into something legible to someone who is
not the author.

> Every fact in §1 was verified against the deployed Identity Registry
> (`CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`, testnet) with the
> `@stellar/stellar-sdk` version this repo already pins. Numbers below are what
> that contract actually returns, not estimates.

---

## 1. Spec extraction

### 1.1 What is in the WASM

A Soroban contract's WASM carries three custom sections. Reading the registry's
6,240-byte module:

| Section             | Size    | Contents                                                                                                    |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `contractspecv0`    | 1,256 B | The interface: functions, argument and return types, user-defined types, error enums, and **doc comments**. |
| `contractmetav0`    | 96 B    | Build provenance — `rsver 1.91.1`, `rssdkver 26.1.0#175aa41…`.                                              |
| `contractenvmetav0` | 12 B    | The protocol interface version the contract was built against.                                              |

`contractspecv0` is the documentation source. `contractmetav0` is worth
surfacing alongside it: "built with soroban-sdk 26.1.0" is a real signal about a
contract's age, and it is free once the module is already parsed.

### 1.2 The read path

Three steps, all read-only, no signature, no fee:

1. **Fetch the WASM.** `rpc.Server#getContractWasmByContractId(address)` — one
   call. It resolves the contract instance ledger entry, reads the executable's
   WASM hash, fetches the matching `ContractCode` entry, and returns the bytes.
   No separate hash lookup is needed.
2. **Pull the custom section.** `WebAssembly.Module.customSections(module,
'contractspecv0')`. This is a platform API — it works in Node and in the
   browser, and it does not require a WASM parser dependency.
3. **Decode the entries.**

```ts
const reader = new XdrReader(Buffer.from(section));
const entries: xdr.ScSpecEntry[] = [];
while (!reader.eof) entries.push(xdr.ScSpecEntry.read(reader));
```

> **Gotcha worth writing down.** `xdr.ScSpecEntry.fromXDR(section)` fails with
> _"source buffer not entirely consumed"_. The section is a bare concatenation
> of entries with no length prefix and no envelope, so it has to be read
> sequentially with a cursor. Anyone reaching for the obvious one-liner will
> hit this; it cost time to find and is the single least obvious thing in the
> whole path.

The registry decodes to 9 entries: 8 `scSpecEntryFunctionV0` and 1
`scSpecEntryUdtErrorEnumV0`.

### 1.3 What the SDK gives us for free

`new contract.Spec(entries)` wraps the decoded entries and already provides:

- `funcs()` / `getFunc(name)` — the function list.
- `jsonSchema(name)` — a **JSON Schema** for a function's arguments
  (`$schema`, `definitions`, `$ref`). This is the piece the sandbox needs to
  render an input form, and it comes out of the box.
- `errorCases()` — the error enum. On the registry: `AlreadyInitialized`,
  `NotInitialized`, `HandleTaken`, `HandleNotFound`, `NotOwner`,
  `InvalidHandle`, `WalletAlreadyBound`.
- `scValToNative` / `nativeToScVal` — the conversions the sandbox needs to
  marshal inputs and render outputs.

**Decision: do not write a spec parser.** `contract.Spec` is maintained
alongside the XDR definitions it decodes; a hand-rolled equivalent would rot on
the next protocol version. The shared reader (§5) is a thin layer over it, not a
replacement for it.

### 1.4 Why this needs no Rust

Spec extraction is _reading structured data_, not executing WASM. `erst` does
the same thing in Go (`cmd/generate-bindings.go` reads the WASM and emits a
typed TypeScript client), which is the proof that the language does not matter
here. The sandbox is the component that must actually run Soroban semantics, and
that is where `soroban-env-host` and the Rust bridge become unavoidable — see
the sandbox design note. Keeping this item in TypeScript means auto-docs can
ship before the bridge exists.

### 1.5 Failure modes

Each has a distinct display, because they mean different things to a reader:

| Condition                     | Cause                                                                         | Shown as                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Contract not found            | Address never deployed, or archived and not restored                          | "Not found on `<network>`" — with the address, so a wrong-network mistake is obvious                         |
| No `contractspecv0` section   | Not built with `soroban-sdk` — hand-written WASM, or a Stellar Asset Contract | "This contract publishes no interface" — a statement about the contract, not an error                        |
| Section present, decode fails | A spec format newer than the pinned SDK                                       | "Interface could not be read" + the SDK version — and it is logged, because it means the SDK needs upgrading |

None of these may render as a generic error page. A contract that publishes no
interface is a fact about that contract and belongs on the page.

---

## 2. Rendering, and where the docs live

### 2.1 Route

```
/p/{handle}/contract/{address}
```

A sub-route of the canonical profile, not a sibling. The contract is being shown
_as part of this developer's record_, and the route should say so — the page
carries the profile's identity (handle, wallet binding, provenance) and the
contract's interface below it.

This revives a route shape that already existed. `/profile/{handle}/contract/{address}`
is currently a `permanentRedirect` to `/p/{handle}`, with the comment _"redirect
to the canonical profile page until a dedicated view is built"_. This is that
view; the legacy path keeps redirecting, to the new sub-route rather than the
profile root.

On `/p/{handle}` itself, each contract in the list links here. The profile stays
a summary; nothing about a contract's interface belongs in the list.

### 2.2 Provenance rules

The profile page draws a hard line between curated demo data and real on-chain
data — `isDemo` gates every claim the page makes. Generated docs inherit that
line and add one of their own:

- **Every fact on the page is derived from the deployed WASM.** Nothing is
  written by Signet, nothing is inferred, nothing is filled in from a similar
  contract.
- The page states which contract id and which **WASM hash** it was generated
  from, and links to the explorer. A reader can re-derive it.
- A demo profile's contracts, if any, are labelled exactly as the rest of a demo
  profile is. Generated docs must not lend a curated address the authority of
  on-chain provenance.

### 2.3 Page shape

1. **Header** — contract address, WASM hash, network, deploy tx (already in the
   `Contract` table), and the `contractmetav0` build provenance.
2. **Functions** — one section each: name, doc comment, arguments with types,
   return type. Sourced from `ScSpecFunctionV0`'s `doc`, `name`, `inputs`,
   `outputs`.
3. **Types** — user-defined structs, unions and enums, only when referenced by a
   function signature. A reader following an argument type must land somewhere.
4. **Errors** — the error enum from `errorCases()`, with its doc comments. What
   a call can fail with is documentation, and it is the half most hand-written
   contract docs omit.

Rendering is static-first, matching `/p/{handle}`: pre-rendered where the
contract set is known, `dynamicParams` for anything newer, and revalidation on
the cache key in §4.

### 2.4 When a contract carries no doc comments

The registry is the good case — 8 of 8 functions documented. Plenty of contracts
will be 0 of 8, and that case decides whether this feature is worth having.

**The signature is still documentation.** `claim(handle: String, wallet:
Address) -> Result<(), Error>` tells a reader most of what they need, and it is
more than a bare `C…` address told them. So an undocumented function renders in
full — name, typed arguments, return type, possible errors — with no prose.

- **No apology, no placeholder.** No "No description available." greyed out
  under every function. Absent prose should read as absent, not as broken.
- **One honest note per page**, not per function: when no function carries a doc
  comment, a single line explains that this contract publishes no doc comments
  and that the signatures below come from the deployed code. A reader then knows
  the emptiness is the contract's, not Signet's.
- **Never invent prose.** Not from the function name, not from an LLM, not from
  a similar contract. The entire value of generated docs is that they cannot be
  wrong about the deployed code; one inferred sentence forfeits that for every
  other sentence on the page.
- **Partial documentation is normal** and needs no explanation — documented
  functions show their prose, undocumented ones show their signature.

---

## 3. Protocol and SDK versions

Spec extraction reads a serialisation format, so its version exposure is much
narrower than the sandbox's — it does not execute anything and has no host
functions to match. Two constraints:

- The **XDR definitions** must know every `ScSpecEntry` arm the contract used.
  Currently: `functionV0`, `udtStructV0`, `udtUnionV0`, `udtEnumV0`,
  `udtErrorEnumV0`, `eventV0`. A contract using an arm the pinned SDK does not
  know decodes as an unknown entry rather than corrupting the rest — hence the
  distinct "interface could not be read" state in §1.5 rather than a silent
  partial page.
- `contractenvmetav0` records the protocol interface version the contract was
  built against. Surface it; do not gate on it. A contract built against an
  older protocol still has a perfectly readable interface, and refusing to
  document it would be a policy about _execution_ applied where it does not
  belong.

The sandbox's version story is a genuinely different problem — `erst`'s
`simulator/` crate pins `soroban-env-host >=21, <26` so one binary spans
protocol versions, and that constraint belongs to the component that runs code.
Auto-docs must not inherit it.

---

## 4. Caching and regeneration

### 4.1 Key on the WASM hash, not the address

This is the decision that makes the rest simple.

A Soroban contract is upgraded by pointing its instance at a **new WASM hash**;
the contract id does not change. So an address is not a stable identifier for an
interface, and caching by address means an upgraded contract serves its old
documentation until something expires — the exact failure the "docs cannot drift
from the code" claim is supposed to rule out.

```
cache key = wasm_hash
```

Consequences that all fall out for free:

- **Upgrade detection is a hash comparison**, not a heuristic. The instance
  entry is cheap to read; when its hash differs from the cached one, the docs
  are stale by definition.
- **Two contracts deploying identical WASM share one cache entry.** Common for
  token contracts, and correct — identical code has an identical interface.
- **Rollback is free.** Reverting to a previous WASM hash hits the entry that is
  already there.
- **Nothing needs invalidating**, because nothing is ever wrong. A hash's
  extracted spec is immutable. Entries are evicted for space, never for
  staleness.

### 4.2 Storage

The `Contract` model already stores `address`, `deployTxHash`, `network` and
timestamps but no WASM hash. Add:

- `wasmHash` on `Contract` — the hash observed at index time, so a stale row is
  detectable without a fetch.
- A `ContractSpec` table keyed by `wasmHash`, holding the decoded entries and
  the extraction's SDK version. Many contracts to one spec.

Recording the SDK version alongside the entries is what makes an SDK upgrade
re-extractable: a spec decoded by an older SDK that skipped an unknown entry arm
can be found and redone.

### 4.3 Refresh trigger

The indexer's `deployment` worker already scans wallets for
`invoke_host_function` operations and writes `Contract` rows. It is the right
place: it is already looking at exactly the operations that deploy and upgrade
contracts, and adding a hash read there costs one ledger-entry lookup per
contract it already touched.

Extraction itself should not run inside that worker — a page render that needs a
spec can extract on demand and populate the cache, and the worker only has to
notice that the hash moved. Ordinary web caching (`revalidate`, as `/p/{handle}`
uses) handles the rest.

---

## 5. The shared spec reader

Three roadmap items read the same data: auto-docs (this note), the sandbox, and
the visualiser. They must not each write their own reader — three parsers means
three answers to "what does this contract expose", and the two that are wrong
will not announce themselves.

**Decision: one module, in TypeScript, owning everything up to the decoded
spec.** Auto-docs is the first consumer and therefore where it lands, but it is
written as a shared dependency from the start.

Its surface:

```ts
/** Fetch and decode a deployed contract's interface. */
fetchContractSpec(address: string, network: Network): Promise<ContractSpec>

/** Decode an already-fetched module — the pure half, and the testable one. */
parseContractSpec(wasm: Uint8Array): ContractSpec

interface ContractSpec {
  wasmHash: string;
  entries: xdr.ScSpecEntry[];   // raw, for consumers needing arms this API omits
  spec: contract.Spec;          // the SDK wrapper: jsonSchema, conversions
  functions: SpecFunction[];    // name, doc, inputs, outputs — flattened
  types: SpecType[];            // structs, unions, enums
  errors: SpecError[];          // the error enum, with docs
  build?: { rustVersion?: string; sdkVersion?: string };  // contractmetav0
}
```

Why this split:

- `parseContractSpec` takes bytes, so every consumer's tests run against a
  fixture WASM with no network. The registry's 6,240-byte module is a good
  first fixture: 8 functions, all documented, plus an error enum.
- `entries` and `spec` are both exposed. The flattened views serve documentation
  rendering; the sandbox needs `spec.jsonSchema()` and the conversion helpers,
  and the visualiser will want arms this interface does not enumerate. Hiding
  the SDK object behind a lossy abstraction would just push each consumer to
  re-decode.
- Fetch and parse are separate because they fail differently — a network error
  and an undecodable section need different messages (§1.5), and merging them
  loses that.

The reader owns fetching, decoding and the `ContractSpec` cache (§4). It does
not own rendering, execution, or anything protocol-version-gated: those belong
to the consumers, and pushing them down here would drag the sandbox's
`soroban-env-host` version constraints into a module that never executes
anything.

---

## 6. Sequencing

Auto-docs has no dependency on terminal linking or on the Rust bridge. It needs
a contract address and an RPC endpoint, both of which exist today, and the
`Contract` rows the indexer already writes.

It should ship **before** the sandbox, and not only because it is smaller: it
builds and proves the shared reader against a real contract, so the sandbox
starts from a spec layer that is already correct and already tested, and can
spend its whole budget on the part only it needs — executing the thing.

---

## Open questions

- **Does the docs page belong behind a profile at all?** `/p/{handle}/contract/{address}`
  ties the contract to a developer's record, which is the Signet framing. But
  the same generated docs are useful for any address, and a
  `/contract/{address}` route with no handle would serve a reader arriving from
  an explorer. Deferred: the profile-scoped route is the one this product needs
  first, and the second is additive.
- **How much of the type graph is rendered inline?** A deeply nested user-defined
  type could dominate a page. Inline for the first level, linked beyond it, is
  the likely answer — but it needs a real contract with a large type graph to
  decide against, and the registry (one error enum, no structs) is not it.
- **Should `contractmetav0` provenance be surfaced on `/p/{handle}` too?**
  "Built with soroban-sdk 26.1.0" is a signal about a contract's age that a
  reader scanning a profile might want before clicking through.
