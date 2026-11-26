# Design: contract documentation generated from the on-chain spec

**Status:** shipped. The whole of the design described here has shipped:
`@signet/spec`, the contract route and tabs, the per-function page, stubs,
changelog, and search.

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

1. **Fetch the WASM.** Both readers live in [`packages/spec/src/fetch.ts`](../packages/spec/src/fetch.ts).
   `fetchContractSpec(address)` reads the contract instance entry with
   `getLedgerEntries` to get the executable's WASM hash (a Stellar Asset
   Contract stops here with `NoInterface`), fetches the module with
   `rpc.Server#getContractWasmByContractId(address)`, and checks that the
   fetched bytes hash to the instance's WASM hash.
   `fetchContractSpecByHash(wasmHash)` skips the instance and reads the
   `ContractCode` ledger entry for that hash directly with `getLedgerEntries`,
   then checks the bytes against the requested hash.
2. **Pull the custom section.** Rather than depending on runtime WASM engines or
   untyped `WebAssembly.Module.customSections`, `@signet/spec` uses its own
   binary section walker ([`packages/spec/src/wasm-sections.ts`](../packages/spec/src/wasm-sections.ts))
   with safety caps (`MAX_WASM_BYTES` at 256 KB, `MAX_WASM_SECTIONS` at 1,024,
   and `MAX_SPEC_ENTRIES` at 1,024), tested against hostile inputs by a dedicated
   fuzz suite ([`packages/spec/src/property-fuzz.test.ts`](../packages/spec/src/property-fuzz.test.ts)).
3. **Decode the entries.** Decoded via `new contract.Spec(section)` and converted
   into structured models with typed failures ([`packages/spec/src/errors.ts`](../packages/spec/src/errors.ts)).

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

Failures map to a typed taxonomy ([`packages/spec/src/errors.ts`](../packages/spec/src/errors.ts)).
The contract page's copy for each failure comes from `failureCopy` in
[`apps/web/lib/contract-overview.ts`](../apps/web/lib/contract-overview.ts);
`classifySpecError` there maps each error's `kind` to the state shown.

| Condition | Error / state | Cause | Shown as |
| --- | --- | --- | --- |
| Contract not found | `ContractNotFound` | Address never deployed, or archived and not restored | "Not found on `<network>`" |
| WASM not found | `WasmNotFound` | No contract-code ledger entry for the WASM hash (expired or evicted) | "Code not found on `<network>`" |
| No interface | `NoInterface` (`no_section`, `stellar_asset_contract`, `empty_section`) | Not built with `soroban-sdk`, a Stellar Asset Contract, or an empty custom section | "This contract publishes no interface" |
| Decode failure | `InterfaceUnreadable` | A spec format newer than the pinned SDK | "Interface could not be read" + SDK version |
| RPC unavailable | `RpcUnavailable` | RPC node unreachable, timeout, or fetched bytes that do not match the expected hash (#944) | "Interface is unavailable right now" |
| Invalid WASM | `InvalidWasm` | Bad magic number or version, truncated section, or size cap exceeded | No copy of its own: `classifySpecError` maps it to the unavailable state, "Interface is unavailable right now" |
| Wrong network | `wrong_network` (loader state, not a `@signet/spec` error) | The contract's network is not the one this deployment reads; `loadContractSpec` in [`apps/web/lib/server/contract-spec.ts`](../apps/web/lib/server/contract-spec.ts) returns it before any RPC call or cache read (#464) | "This contract is on `<network>`" |

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

The profile page only ever renders real data — a binding from the indexer's
database or a live registry `resolve`, and activity from the database or
Horizon. Generated docs hold to the same rule:

- **Every fact on the page is derived from the deployed WASM.** Nothing is
  written by Signet, nothing is inferred, nothing is filled in from a similar
  contract.
- The page states which contract id and which **WASM hash** it was generated
  from, and links to the explorer. A reader can re-derive it.

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

Rendering is static-first: pre-rendered where the
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

The `ContractSpec` table ([`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma)),
implemented via `PrismaSpecCache` ([`apps/web/lib/server/spec-store.ts`](../apps/web/lib/server/spec-store.ts)),
is keyed by `wasmHash` alone. It stores:

- `wasmHash` — lowercase hex SHA-256 of the WASM bytecode.
- `schemaVersion` — shape version of the stored payload (`SPEC_SCHEMA_VERSION = 1`, #434).
- `sdkVersion` — `@stellar/stellar-sdk` version that extracted the entries (`RUNNING_SDK_VERSION = '16.1.0'`).
- `specJson` — the serialised `SpecJson` payload.
- `extractedAt` — timestamp when extracted.

**The stale-SDK rule:** `isStale(row)` in [`apps/web/lib/server/spec-store.ts`](../apps/web/lib/server/spec-store.ts)
checks whether the stored row was extracted by an older SDK version or older schema version.
If stale, the row is re-extracted and overwritten on access rather than served to users.

**Cache-key rule (#944):** A resolved spec's `wasmHash` must strictly equal its cache key.
`assertHashMatches` in [`packages/spec/src/resolve.ts`](../packages/spec/src/resolve.ts)
verifies this before caching, preventing mismatched bytecode from polluting the cache.

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

The shared spec reader lives in [`packages/spec`](../packages/spec) (`@signet/spec`).
It serves auto-docs, the sandbox, the visualiser, and the public REST API:

- **Browser-safe core (`@signet/spec`):** Pure parser, schema checkers, diffing,
  and formatting. Decodes WASM custom sections into `SpecJson` ([`packages/spec/src/types.ts`](../packages/spec/src/types.ts))
  with functions, arguments, return types, custom types, error enums, and build provenance.
- **Network fetch (`@signet/spec/fetch`):** `fetchContractSpec(address, opts)` and
  `fetchContractSpecByHash(wasmHash, opts)` in [`packages/spec/src/fetch.ts`](../packages/spec/src/fetch.ts)
  pull the instance entry and bytecode over Soroban RPC.
- **Cached resolver (`@signet/spec/resolve`):** `getContractSpec(address, opts)`
  in [`packages/spec/src/resolve.ts`](../packages/spec/src/resolve.ts) walks a cache chain
  (in-memory LRU, then the Postgres `ContractSpec` store via `PrismaSpecCache`) and executes
  single-flight in-flight deduplication (`inFlight`) so concurrent requests for the same WASM hash
  share a single RPC download.
- **Opt-in Orbital fallback:** If a contract has no embedded spec section, the resolver can query
  the Orbital registry when `SIGNET_SPEC_ORBITAL_FALLBACK=1` ([`packages/spec/src/fallback/orbital.ts`](../packages/spec/src/fallback/orbital.ts)).

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

## Decisions and open questions

### Decisions

- **Does the docs page belong behind a profile at all?**
  Shipped both: `/p/{handle}/contract/{address}` provides the profile-bound developer context,
  while a handle-less reader is available via the public REST API at
  `GET /api/v1/contracts/{address}/spec` ([`apps/web/app/api/v1/contracts/[address]/spec/route.ts`](../apps/web/app/api/v1/contracts/[address]/spec/route.ts)).
- **How much of the type graph is rendered inline? (#490)**
  Decided in #490: The interface view flattens user-defined types into an interactive closure
  ([`packages/spec/src/closure.ts`](../packages/spec/src/closure.ts)), expanding referenced
  structs, unions, and enums with type links rather than deep recursive inline nesting.

### Still open

- **Should `contractmetav0` provenance be surfaced on `/p/{handle}` too?**
  "Built with soroban-sdk 26.1.0" is surfaced on the contract page header, but is still not shown
  in the compact contract summary list on the developer's canonical `/p/{handle}` profile page.
