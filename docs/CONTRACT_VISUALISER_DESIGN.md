# Design: visualise a contract for non-developers

**Status:** design note. Nothing here is built yet. This document exists to
settle the shape before code, and — like the sandbox note — because
investigating it changes what should be built. It is the third consumer of the
shared spec reader that `CONTRACT_DOCS_DESIGN.md` §5 specifies and auto-docs
builds first; it should not start before that reader exists.

A profile proves _what_ an address deployed. To a reader who does not write
Rust, a deployed contract is a `C…` string and an operation count. Auto-docs
turns that into a readable reference. This item asks for the layer above the
reference: a picture — the contract's call surface, which functions change
state, its state layout, and how it relates to the contracts it calls — that a
grant reviewer or hiring manager can read at a glance.

> Every fact in §1 was checked against the deployed Identity Registry
> (`CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`, Stellar testnet)
> with the `@stellar/stellar-sdk` (`^16.1.0`) this repo already pins.
> `contract.Spec.fromWasm` decodes its 6,240-byte module to **9 spec entries: 8
> functions and 1 error enum, and no user-defined types**. `simulateTransaction`
> of `count()` from a `Keypair.random()` source returns a footprint of 2
> read-only entries and **0 read-write**. Those numbers are what the sections
> below reason about.

---

## 1. What the spec contains, and what it does not

The roadmap item lists four things the visual should show. Investigating the
spec format, only one of them is actually in it. This is the finding that
shapes the rest of the note.

### 1.1 Derivable from `contractspecv0` alone

The custom WASM section the shared reader decodes carries the contract's
**interface**, and that is enough for:

- **The function inventory** — every callable's name, its typed arguments, and
  its return type. On the registry: `claim(handle: String, wallet: Address) ->
Result`, `count() -> u32`, `resolve(handle: String) -> Option`, and five more.
- **The type graph** — user-defined structs, unions and enums, and the edges
  between them: which functions reference which types in their signatures, and
  which types contain fields of other types. This is a real, directed,
  spec-only relationship, and it is the one a diagram renders better than a
  list. (The registry has none — see §3.)
- **The error surface** — the `contracterror` enum (`HandleTaken`, `NotOwner`,
  `WalletAlreadyBound`, …). It is a property of the contract, not of a single
  function; the spec does not say which function returns which error.
- **Declared events** — when a contract uses `#[contractevent]`, their topics
  and payload types appear as spec entries. Which function _emits_ a given
  event is not in the spec.
- **Build provenance** — `contractmetav0` gives the `soroban-sdk` and `rustc`
  versions. Free once the module is parsed; a signal about a contract's age.

### 1.2 Not in the spec: which functions mutate versus read

`contractspecv0` has **no view / mutability annotation**. A function entry
carries `doc`, `name`, `inputs`, `outputs` and nothing else. In the decoded
registry, `count()` (a pure read) and `claim(...)` (a state write gated by
`require_auth`) are structurally identical entries — only the return type
differs, and that is not a reliable signal either: `resolve` returns `Option`,
`is_bound` returns `bool`, `claim` returns `Result`, and a mutator is free to
return a value.

The mutate/read split has to come from somewhere else:

- **Simulation (authoritative).** `simulateTransaction` returns a
  `SorobanTransactionData` footprint that separates `readOnly` from
  `readWrite` ledger entries. A function whose simulated `readWrite` footprint
  is empty did not change state; one that declares written entries did. This is
  exactly the data the sandbox note found, verified: `count()` simulates to
  `readWrite: 0`. No wallet, no signature, no fee.
- **Indexed activity (weaker).** A function that has appeared in
  state-changing transactions is a mutator; the absence of evidence is not
  evidence of absence.
- **Return-type / name heuristic (a guess, and must be labelled one).**
  `get_*` / `is_*` / `-> Option<T>` _suggests_ a read. It is wrong often
  enough that shipping it unlabelled would undermine the "derived from the
  deployed code, cannot be wrong" property the whole feature rests on.

### 1.3 Not in the spec: the state layout

Soroban has **no declared storage schema**. Contract storage is a dynamic
key→value map across three durabilities (`instance`, `persistent`,
`temporary`), and the key type (`DataKey`, typically) is an implementation
detail that usually appears in no function signature, so it is not in the spec
at all.

What is observable:

- **Live ledger entries** via `getLedgerEntries` — but only for keys you
  already know. There is no "enumerate this contract's persistent entries"
  RPC. The `instance` entry (which every contract has) is enumerable and
  carries the contract's own storage map for small contracts; beyond that you
  are guessing keys.
- **Indexed snapshots.** `ContractSnapshot` already records activity counts
  over time; a schema-shaped view of state would be a much larger indexer
  change.

So "state layout" in phase 1 is limited to what the `instance` entry exposes,
labelled as _observed at ledger N_, not _the contract's schema_ — because
there is no schema to show.

### 1.4 Not in the spec: how it relates to contracts it calls

`contractspecv0` describes the interface a contract **exposes**, never the
contracts it **invokes**. Cross-contract call edges come from:

- **Simulation footprint** — other contract _instance_ entries that show up in
  the footprint of a simulated call are contracts this one reads or invokes.
  Per-function, and only for the code paths that call arguments exercise.
- **Transaction meta from the indexer** — `InvokeHostFunction` sub-calls are
  visible in transaction result meta. Aggregated across real activity this
  gives the actual call graph, weighted by how often each edge is taken.
- **An `Address`-typed argument named `token` or `pool`** is a _hint_ a
  reader can see in the signature already. It is not an edge and must not be
  drawn as one.

### 1.5 Summary

| Relationship the item asks for               | In the spec?                                              | Otherwise                                       |
| -------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Call surface — functions, arg & return types | **Yes**                                                   | —                                               |
| Type graph — function → type → type          | **Yes**                                                   | —                                               |
| Error surface                                | Partial — the enum, not the per-function mapping          | source, or `errorCases()`                       |
| Declared events & payloads                   | Partial — the declarations, not which function emits them | transaction meta                                |
| Which functions mutate vs read               | **No**                                                    | simulation footprint (`readWrite` empty ⇒ read) |
| State layout                                 | **No** — Soroban has no declared schema                   | live `instance` entry; indexed snapshots        |
| Cross-contract call graph                    | **No**                                                    | simulation footprint; indexer transaction meta  |

### 1.6 Consequence: three phases

**Phase 1 — the spec-only diagram.** Ships on top of the shared reader, with
no execution, no bridge, no dependency on terminal linking. Draws the call
surface and the type graph, lists the error surface and declared events, shows
build provenance. This is a genuine improvement over a flat function list for
any contract with a non-trivial type graph, and it is honest about showing
only what the interface contains.

**Phase 2 — the mutate/read overlay.** Adds the read-vs-write mark to each
function from a simulated footprint, reusing the sandbox's phase-1 simulate
route (`CONTRACT_SANDBOX_DESIGN.md` §2.1) rather than building its own. Still
no Rust.

**Phase 3 — the call graph.** Draws edges to other contracts from indexer
transaction meta, weighted by observed frequency. This is the largest piece —
it needs the indexer to record sub-invocations — and it is where the picture
the roadmap item imagines ("how it relates to contracts it calls") actually
appears.

Deciding this now matters because phase 1 is a layout function and an inline
SVG, while phase 3 is an indexer schema change. "Visualise a contract" reads
like one feature; most of its cost is in the third of it that the spec cannot
feed.

---

## 2. The rendering approach

### 2.1 Not a force-directed graph

A physics layout is non-deterministic (the same contract lays out differently
each render), illegible past ~15 nodes, and needs a client-side engine — all
three at odds with a profile page that is static-first and cached. The
structure here is not an arbitrary network anyway; it is a shallow, mostly
directed graph (functions → types) with a known root. That lays out
deterministically.

### 2.2 What the diagram is

- **A deterministic layout.** Same `wasmHash` → same diagram, always. Layout is
  a pure function of the decoded spec, computed once and cached alongside it
  (§4), not re-solved per render.
- **Server-rendered inline SVG.** No canvas, no runtime graph library. The
  page it lives on pre-renders where the contract set is known and revalidates
  otherwise, exactly as `/p/{handle}` does today; the diagram is part of that
  HTML.
- **Shape:** the contract as a labelled spine of its functions (grouped, §3),
  with referenced types as a second rank to the right and edges from each
  function to the types in its signature. Errors and events are lists below the
  spine, not nodes — they connect to everything or nothing, so drawing them as
  nodes adds edges without adding meaning.
- **Every function label is a real `<a>`** to its section in the generated
  docs on the same page (§4). The diagram is a table of contents you can see
  the structure of.

### 2.3 Both themes, and accessibility

The site renders dark-only today, but the diagram must be authored
theme-agnostic — it will be lifted out of page context (OpenGraph images,
future light theme, a reader printing a profile) and has to stay correct.

- **Colour through tokens, never hardcoded.** The SVG uses `currentColor` and
  a small custom-property set (`--viz-node`, `--viz-edge`, `--viz-accent`,
  `--viz-muted`) defined once on the page and redefined per theme. The SVG
  file itself names no hex values.
- **Never hue alone.** A mutating function is marked by a glyph and a label
  _and_ a colour, so the distinction survives greyscale, colour-blindness, and
  a theme that drops the accent. This is the same discipline the profile
  page's demo-vs-on-chain badges already follow — icon plus text plus colour,
  not colour alone.
- **Contrast holds on both grounds.** Text and strokes meet WCAG AA (≥4.5:1
  for text) against both `#0a0908` and a white ground. Minimum _rendered_ text
  size 12px; if the diagram would have to shrink text below that to fit, it
  switches to the collapsed view (§3) instead of scaling down.
- **A non-visual equivalent exists** — the generated docs on the same page
  _are_ it. The `<svg>` carries `role="img"` with a `<title>`/`<desc>`
  summarising node and edge counts; the authoritative structure for a screen
  reader is the docs below, and the function links in the diagram point into
  them.
- **No motion.** No entrance animation, no animated edge flow. `globals.css`
  already collapses transitions under `prefers-reduced-motion`; the diagram
  adds nothing that needs it.

### 2.4 The diagram is an enhancement, never a replacement

If layout fails, the spec is undecodable, or the contract publishes no
interface (`CONTRACT_DOCS_DESIGN.md` §1.5), the docs page still renders in
full. The visual is additive markup on a page that is complete without it.

---

## 3. Degrading for a large surface

The registry is the low end — 8 functions, no types, no external calls. It
would render as one spine of eight labels with no edges, and for a contract
that simple **the generated docs already say everything the diagram could**;
phase 1 should just not draw a graph with no edges.

The high end is a router, an AMM, or a governance contract: 40+ functions, a
type graph several levels deep, calls into a dozen token contracts. A single
diagram of that is a hairball. Strategy, in order of effort:

- **Group functions by name prefix.** Soroban contracts conventionally
  namespace (`pool_*`, `admin_*`, `get_*`). Clustering on the prefix is a
  spec-only heuristic that turns 40 flat labels into 5 groups a reader can
  scan. Groups collapse and expand.
- **Rank within a group.** With phase-3 data, order by observed call frequency
  so the functions people actually use are on top. Without it, public
  entrypoints before admin/init.
- **Inline the type graph one level, link beyond it.** A function's direct
  argument types are drawn; types nested inside those are links to their own
  section. (This is the same open question auto-docs has — decide it against a
  real contract with a deep type graph, not the registry.)
- **Bound the viewport, don't autofit.** Above the size where text would drop
  below 12px, the diagram scrolls within a fixed-height container (wide
  content in its own scroll region, never the page body) rather than shrinking
  to a thumbnail.
- **A hard ceiling.** Past ~60 nodes after grouping, phase 1 renders the
  grouped function list from the docs with a one-line note that the contract's
  surface is too large to diagram usefully, instead of a picture no one can
  read. A diagram that cannot be read is worse than the list it replaced.

---

## 4. Composition with the generated docs

### 4.1 One page, two altitudes

The diagram lives at the **top of** `/p/{handle}/contract/{address}` — the
route `CONTRACT_DOCS_DESIGN.md` §2.1 defines and the current
`profile/[handle]/contract/[address]` redirect is a placeholder for — with the
generated reference documentation below it. The diagram is the overview a
non-developer reads first; the docs are the detail. A function node links to
its doc section by anchor.

`/p/{handle}` itself stays a summary: it lists a developer's contracts and
links here. No diagram on the profile root — same rule auto-docs sets for the
reference content.

### 4.2 One reader, one cache key

The visualiser does not touch the WASM. It consumes the shared reader's
`ContractSpec` (`fetchContractSpec(address, network)` /
`parseContractSpec(wasm)` from `CONTRACT_DOCS_DESIGN.md` §5) and adds one pure
function:

```ts
/** Deterministic layout from a decoded spec. No I/O. */
layoutContractGraph(spec: ContractSpec): DiagramModel
```

`DiagramModel` is nodes and edges with resolved positions — enough for the
renderer to emit SVG with no further computation. It is cached on `wasmHash`
exactly as the spec is (`CONTRACT_DOCS_DESIGN.md` §4): an interface that has
not changed has a layout that has not changed, and an upgraded contract
(new WASM hash) gets both re-derived together.

Phase 2's mutate/read marks and phase 3's call edges are separate overlays
keyed on `(wasmHash, network)` and `(address, network, ledgerRange)`
respectively — derived data with different freshness, not baked into the
spec-only layout.

### 4.3 Provenance, identical to the docs

- Every node and every phase-1 edge is derived from the deployed WASM at a
  stated hash. Nothing is inferred, nothing is authored by Signet.
- Phase-2 marks are labelled _observed via simulation at ledger N_; phase-3
  edges _from indexed activity, N transactions_ — visually distinct from the
  spec-only structure, because they carry a weaker, time-bound guarantee.
- A demo profile's contracts, if any, are labelled exactly as the rest of a
  demo profile is (`isDemo` in `apps/web/app/p/[handle]/page.tsx`). A diagram
  must not lend a curated address the authority of on-chain provenance.

### 4.4 Storage

Follows the auto-docs note: `wasmHash` on `Contract`, a `ContractSpec` table
keyed by hash. The visualiser adds at most a `layout Json?` column on
`ContractSpec` (or recomputes on render — layout is cheap and pure). No new
top-level model in phase 1.

---

## 5. Sequencing

1. **Auto-docs** (`CONTRACT_DOCS_DESIGN.md`) — builds and proves the shared
   spec reader. No dependency on this note.
2. **Visualiser phase 1** — `layoutContractGraph` + the SVG renderer over that
   reader. No execution, no bridge, no linking.
3. **Sandbox phase 1** (`CONTRACT_SANDBOX_DESIGN.md`) — the simulate route.
4. **Visualiser phase 2** — the mutate/read overlay, reusing that route.
5. **Indexer sub-invocation capture**, then **visualiser phase 3** — the
   call graph.

Phase 1 has everything it needs the moment the shared reader lands. The
roadmap item's framing — call surface, state layout, mutate vs read, call
graph — is delivered across phases 1–3, and the note's job is to make clear
that only the first is a small piece of work.

---

## Open questions

- **Is a diagram the right primitive at all for a simple contract?** For a
  flat token with five functions and no types, the diagram adds nothing over
  the docs list. Phase 1 should have a "not worth drawing" threshold — but
  where it sits needs real contracts to calibrate.
- **Where does the mutate/read mark come from before phase 2?** Shipping the
  return-type heuristic in phase 1, clearly labelled as a guess, versus
  leaving the mark off entirely until simulation can back it. Leaning towards
  off — an unlabelled guess is the one thing that breaks the "cannot be wrong"
  property.
- **Does the diagram belong on the OpenGraph image?** A contract's shape in a
  shared profile card is a strong hook, but the OG renderer
  (`apps/web/app/p/[handle]/opengraph-image.tsx`) is size- and
  complexity-bound and would need the collapsed view (§3) as its only mode.
- **How much interactivity is worth the static-rendering cost?** Pure SVG
  (grouping expanded at render time, no JS) versus a little client JS for
  collapse/expand and pan on large graphs. Phase 1 should try to stay pure.
- **A `/contract/{address}` route with no handle** — the same diagram is
  useful for any address, not only one on a profile. Deferred to auto-docs's
  version of this question; the profile-scoped route is what ships first.
