# Design: visualise a contract for non-developers

**Status:** phase 1 built, phases 2 and 3 in place as observed overlays.
The [`@signet/visualiser`](../packages/visualiser/README.md) package draws the
interface (graph, grouping with collapse, layout, routing, SVG renderer,
outline, interactive enhancers), and the web Diagram tab and `signet visualise`
use it. The read/write marks, call graph, storage view and
activity overlay are drawn from indexed calls and labelled as observed.
Plain-language reading guide: the "Reading a contract diagram" section of the
site's `/docs` page.

This document was written to settle the shape before code. §1, what the spec
does and does not contain, is kept as it was written, because it still decides
what each part of the diagram may claim. §2 to §5 have been brought up to what
was built: where the plan and the code differ, the text says what the code
does and names the file. §6 lists the surfaces that draw a diagram, and the
open questions are split into decisions and what is still open.

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
function. The plan was to take it from a simulated footprint, reusing the
sandbox's phase-1 simulate route (`CONTRACT_SANDBOX_DESIGN.md` §2.1). What was
built takes it from footprints that were observed instead, and the web app
never simulates on a visitor's behalf:

- **Indexed invocations.** The indexer stores each invocation's footprint in a
  `ContractInvocation` row. `getMutabilityOverlay`
  (`apps/web/lib/server/diagram.ts`) reads the latest
  `MUTABILITY_PER_FUNCTION` (50) of each function, and `classifyFunctions`
  (`packages/spec/src/observe/classify.ts`) turns them into one mark per
  function.
- **Local sandbox runs.** In the `signet dev` UI the marks come from that
  session's own runs (`fromSandboxTrace`,
  `packages/visualiser/src/observe/sandbox.ts`). They stay on the developer's
  machine and are labelled as local.

The renderer says which of the two it was, under the diagram (`describeMarks`,
`packages/visualiser/src/render.ts`).

**Phase 3 — the call graph.** Draws edges to other contracts from indexer
transaction meta, weighted by observed frequency. This was the largest piece —
it needed the indexer to record sub-invocations — and it is where the picture
the roadmap item imagines ("how it relates to contracts it calls") actually
appears. `loadContractCallGraph` (`apps/web/lib/server/call-graph-source.ts`)
aggregates the call edges of the newest `CALL_GRAPH_WINDOW` (1000) stored
invocations.

Deciding this early mattered because phase 1 is a layout function and an
inline SVG, while phase 3 is an indexer schema change. "Visualise a contract"
reads like one feature; most of its cost is in the third of it that the spec
cannot feed.

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
  a pure function of the decoded spec. The Diagram tab keeps the spec-only
  layout in a per-process cache (§4.2) rather than re-solving it per render.
- **Server-rendered inline SVG.** No canvas, no runtime graph library. The
  contract routes are rendered on request (`dynamic = 'force-dynamic'` in
  `apps/web/app/p/[handle]/contract/[address]/layout.tsx`), not pre-rendered
  as first planned, and the diagram is part of that HTML.
- **Shape:** the contract as a labelled spine of its functions (grouped, §3),
  with referenced types as a second rank to the right and edges from each
  function to the types in its signature. Errors and events are lists below the
  spine, not nodes — they connect to everything or nothing, so drawing them as
  nodes adds edges without adding meaning.
- **Every function label is a real `<a>`**, and so is every type. A function
  links to its section on the contract's Functions tab
  (`…/functions#fn-<name>`) and a type to the Types tab
  (`…/types#type-<name>`), not to an anchor on the same page (§4.1). The
  diagram is a table of contents you can see the structure of.

### 2.3 Both themes, and accessibility

The site renders dark-only today, but the diagram must be authored
theme-agnostic — it will be lifted out of page context (OpenGraph images,
future light theme, a reader printing a profile) and has to stay correct.

- **Colour through tokens, never hardcoded.** The SVG uses `currentColor` and
  a small custom-property set (`--viz-node`, `--viz-edge`, `--viz-accent`,
  `--viz-muted`) defined once on the page and redefined per theme. The SVG
  file itself names no hex values. The one exception is the standalone export
  (`renderStandaloneSvg`), which writes the token values into its own
  `<style>` block so that the file works outside the page.
- **Never hue alone.** A mutating function is marked by a glyph and a label
  _and_ a colour, so the distinction survives greyscale, colour-blindness, and
  a theme that drops the accent. This is the same discipline the profile
  page's provenance badge already follows — icon plus text plus colour, not
  colour alone.
- **Contrast holds on both grounds.** Text and strokes meet WCAG AA (≥4.5:1
  for text) against both `#0a0908` and a white ground. Minimum _rendered_ text
  size is 12px (`MIN_TEXT_PX`, `packages/visualiser/src/metrics.ts`). A
  diagram that does not fit is not scaled down to fit: it scrolls inside a
  bounded region, and the zoom steps stop where text would drop below 12px
  (`packages/visualiser/src/interactive/viewport.ts`).
- **A non-visual equivalent exists.** It is the outline, "Diagram as text": a
  `<details>` after the SVG that lists what the diagram draws
  (`buildDiagramOutline` and `renderOutlineHtml`, mounted by
  `apps/web/app/p/[handle]/contract/[address]/_slots/contract-diagram.tsx`),
  which the SVG points at with `aria-describedby`. The `<svg>` itself carries
  `role="figure"`, not `role="img"`, with a `<title>` and `<desc>` summarising
  node and edge counts: an img's children are presentational, and the nodes
  here are links (`renderDiagramSvg`, `packages/visualiser/src/render.ts`).
  Only the standalone export, which has no links, uses `role="img"`.
- **No motion.** No entrance animation, no animated edge flow. `globals.css`
  already collapses transitions under `prefers-reduced-motion`; the diagram
  adds nothing that needs it.

### 2.4 The diagram is an enhancement, never a replacement

If layout fails, the spec is undecodable, or the contract publishes no
interface (`CONTRACT_DOCS_DESIGN.md` §1.5), the reference still renders in
full: the Functions and Types tabs are separate routes and do not depend on
the diagram. Two of those cases do not break the Diagram tab either. When the
spec's entries do not decode it draws from the flattened views alone
(`specForGraph`, `apps/web/lib/server/diagram-view.ts`), and when there is no
spec it shows a placeholder.

---

## 3. Degrading for a large surface

The registry is the low end — 8 functions, no types, no external calls. It
would render as one spine of eight labels with no edges, and for a contract
that simple **the generated docs already say everything the diagram could**.
So a graph with no edges is not drawn: `diagramDecision`
(`packages/visualiser/src/decide.ts`) returns `too-simple` when the graph has
no more than `MIN_EDGES` (0) spec-derived edges. The Diagram tab then says the
function list is the complete picture, and still offers the outline.

The high end is a router, an AMM, or a governance contract: 40+ functions, a
type graph several levels deep, calls into a dozen token contracts. A single
diagram of that is a hairball. The thresholds below were round numbers in the
plan and are named constants now. What was built, in the order it applies:

- **Group functions by name prefix.** Soroban contracts conventionally
  namespace (`pool_*`, `admin_*`, `get_*`). Clustering on the prefix is a
  spec-only heuristic that turns 40 flat labels into 5 groups a reader can
  scan. A prefix forms a group once `MIN_GROUP_SIZE` (3) functions share it
  (`packages/visualiser/src/group.ts`).
- **Collapse the groups of a large contract.** Past `COLLAPSE_THRESHOLD` (25)
  functions every group is drawn as one node, `pool_* (12)`, that links to the
  URL expanding it (`packages/visualiser/src/collapse.ts`). The state lives in
  the URL (`?expand=pool,admin`) and the server draws it, so it works without
  JavaScript.
- **Rank within a group.** `?order=use` orders functions by how often they
  were observed in use, so the ones people actually call come first. It is
  off by default, and the order is then left as it was.
- **Inline the type graph one level, link beyond it.** A function's direct
  argument and return types are drawn: `DEFAULT_TYPE_DEPTH` is 1
  (`packages/visualiser/src/type-graph.ts`). A named type nested deeper
  becomes a stub node that carries only its name, the number of edges it
  hides and its docs anchor.
- **Bound the viewport, don't autofit.** The diagram scrolls within a bounded
  region (wide content in its own scroll region, never the page body) rather
  than shrinking to a thumbnail, and zoom stops where text would drop below
  12px (`packages/visualiser/src/interactive/viewport.ts`).
- **A hard ceiling.** More than `MAX_NODES` (60) nodes is `too-large`
  (`decide.ts`). On the Diagram tab the count is taken after collapsing,
  because `drawContractDiagram` decides on the collapsed graph. The tab then
  says how many nodes the interface has and that it is too large to diagram
  usefully on one canvas, and gives the outline instead of a picture no one
  can read. A diagram that cannot be read is worse than the list it replaced.
  `decide.ts` marks this number as provisional: it has not been calibrated
  against real contracts.
- **A second ceiling, on the work itself.** Above `MAX_RAW_NODES` (500) raw
  nodes `layoutContractGraph` returns a `too-large` model at once, without
  running the layout (`packages/visualiser/src/layout.ts`).

When the interface is too simple or too large to draw but calls to other
contracts were observed, the tab draws those calls on their own, from the
functions that made them (`callersOnly`,
`packages/visualiser/src/observe/call-graph.ts`).

The SVG export and `signet visualise` do not collapse groups, so for them the
60-node ceiling applies to the whole graph (§6).

---

## 4. Composition with the generated docs

### 4.1 One contract, two altitudes

The plan put the diagram at the **top of** `/p/{handle}/contract/{address}` —
the route `CONTRACT_DOCS_DESIGN.md` §2.1 defines — with the generated
reference documentation below it on the same page. What was built is a tab of
its own, `/p/{handle}/contract/{address}/diagram`
(`apps/web/app/p/[handle]/contract/[address]/diagram/page.tsx`), beside the
Functions and Types tabs that hold the reference. The two altitudes are the
same: the diagram is the overview a non-developer reads first; the docs are
the detail. But a node links across to another tab, not down the page: a
function to `…/functions#fn-<name>` and a type to `…/types#type-<name>`
(`hrefForNode` in `drawContractDiagram`,
`apps/web/lib/server/diagram-view.ts`).

The older `profile/[handle]/contract/[address]` route, which the plan called a
placeholder, is now a permanent redirect to the contract view.

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
renderer to emit SVG with no further computation. An interface that has not
changed has a layout that has not changed, and an upgraded contract (new WASM
hash) gets both re-derived together.

In the implementation the layout step takes the abstract graph that
`buildContractGraph` derives from the spec (§2.2), not the spec itself, and
returns a `PositionedDiagramModel`: `layoutContractGraph(graph: ContractGraph):
PositionedDiagramModel`. The spec-to-diagram pipeline composes the two, then
routes the edges (`routeDiagram`). The layout is hand-rolled columns with
barycentre ordering (§2.1), and its `layoutVersion` goes into the cache key
alongside `wasmHash`, so a change to the algorithm invalidates cached layouts.

**Where the layout is cached.** Not next to the spec, as this section first
said. The Diagram tab, the fragment route and the embed page all draw through
`drawContractDiagram`, which keeps spec-only layouts in a per-process LRU
(`layoutCache`, at most 200 entries, in
`apps/web/lib/server/diagram-view.ts`). The key is
`wasmHash:LAYOUT_VERSION:expanded groups`, so each collapse state of a
contract has its own entry, an upgraded contract gets a new one, and bumping
`LAYOUT_VERSION` (`packages/visualiser/src/layout.ts`) retires every cached
layout. The cache is lost on restart and is not shared between server
instances. A layout that carries a call graph or an activity overlay is
computed on each request and is not cached.

A database-backed cache exists in the code and is not used. `getDiagram` and
`PrismaDiagramStore` (`apps/web/lib/server/diagram.ts`) read and write
`ContractSpec.layout` and `ContractSpec.layoutVersion`, but `getDiagram` has
no caller outside its own tests, so nothing on the site fills or reads those
columns. Wiring that cache up or deleting it is a change of its own; this note
only records the fact.

Phase 2's mutate/read marks and phase 3's call edges are separate overlays —
derived data with different freshness, not baked into the spec-only layout.
The marks are cached per `network:address:wasmHash` for `MUTABILITY_TTL_MS`
(five minutes), and the call graph is drawn from the newest
`CALL_GRAPH_WINDOW` stored invocations.

### 4.3 Provenance, identical to the docs

- Every node and every phase-1 edge is derived from the deployed WASM at a
  stated hash. Nothing is inferred, nothing is authored by Signet.
- Phase-2 marks and phase-3 edges are labelled as observed, with what they
  were observed in. Under the diagram, `describeMarks` gives the number of
  transactions and the ledgers they span and says the marks are not derived
  from the contract interface, and `describeCallWindow`
  (`packages/visualiser/src/observe/call-graph.ts`) does the same for the
  calls and adds that calls which never happened in that window are not
  shown. Local sandbox runs are counted separately in both lines. Both are
  drawn visually distinct from the spec-only structure, because they carry a
  weaker, time-bound guarantee.
- A diagram is only ever drawn for a contract a real, chain-bound profile
  deployed; there is no curated or fixture data for it to lend on-chain
  authority to.

### 4.4 Storage

Follows the auto-docs note: `wasmHash` on `Contract`, a `ContractSpec` table
keyed by hash. The visualiser added two nullable columns to `ContractSpec`,
`layout Json?` and `layoutVersion Int?` (`packages/db/prisma/schema.prisma`),
for the database-backed layout cache. That cache is not wired up (§4.2), so
the columns are currently unused: nothing on the site writes or reads them,
and the layout is recomputed on render or taken from the per-process cache —
layout is cheap and pure. No new top-level model was added for the spec-only
diagram.

---

## 5. Sequencing

1. **Auto-docs** (`CONTRACT_DOCS_DESIGN.md`) — builds and proves the shared
   spec reader. No dependency on this note.
2. **Visualiser phase 1** — `layoutContractGraph` + the SVG renderer over that
   reader. No execution, no bridge, no linking.
3. **Sandbox phase 1** (`CONTRACT_SANDBOX_DESIGN.md`) — the simulate route.
4. **Visualiser phase 2** — the mutate/read overlay. The plan had it reuse
   that route. It was built from indexed `ContractInvocation` footprints and
   from local sandbox runs instead (§1.6), so it does not depend on step 3.
5. **Indexer sub-invocation capture**, then **visualiser phase 3** — the
   call graph.

Phase 1 has everything it needs the moment the shared reader lands. The
roadmap item's framing — call surface, state layout, mutate vs read, call
graph — is delivered across phases 1–3, and the note's job is to make clear
that only the first is a small piece of work.

---

## 6. Surfaces

These are the places that draw a contract diagram. They share the graph and
the layout, and differ in which renderer they end in.

| Surface            | Entry point                                                                                            | Draws through                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Diagram tab        | `apps/web/app/p/[handle]/contract/[address]/diagram/page.tsx`, which mounts the `ContractDiagram` slot | `drawContractDiagram` → `renderDiagramSvg`                                   |
| Fragment route     | `…/diagram/fragment/route.ts` → `exportDiagramFragment` (`apps/web/lib/server/diagram-fragment.ts`)    | `drawContractDiagram` → `renderDiagramSvg`                                   |
| `diagram.svg`      | `…/diagram.svg/route.ts` → `exportContractDiagram` (`apps/web/lib/server/diagram-export.ts`)           | `layoutContractGraph` → `renderStandaloneSvg`                                |
| PNG                | `…/diagram/export-png-button.tsx`, in the browser                                                      | `exportDiagramPng` (`packages/visualiser/src/interactive/png.ts`)            |
| Embed              | `…/embed/page.tsx`, which mounts the same `ContractDiagram` slot                                       | `drawContractDiagram` → `renderDiagramSvg`                                   |
| `signet visualise` | `cli/internal/cmd/visualise.go`, which runs the bundle embedded in `cli/internal/visualise/`           | `visualise` (`packages/visualiser/src/visualise.ts`) → `renderStandaloneSvg` |
| `signet dev` UI    | `drawBuild` in `apps/sandbox-ui/src/diagram.ts`                                                        | `layoutContractGraph` → `renderDiagramSvg`                                   |

`…` stands for `apps/web/app/p/[handle]/contract/[address]`. What sets them
apart:

- **The Diagram tab, the fragment route and the embed page** are one
  drawing. `drawContractDiagram` (`apps/web/lib/server/diagram-view.ts`)
  collapses groups, applies the overlays, takes the worth-drawing decision
  and uses the layout cache (§4.2). The fragment route returns only the drawn
  region, which `packages/visualiser/src/interactive/expand.ts` swaps in
  place when a group is expanded.
- **`diagram.svg`** is the interface alone: no collapsing, no overlays and no
  links, with the address, network and WASM hash in a footer. It answers 422
  when the graph has more than `MAX_NODES` nodes. `?view=storage` draws the
  storage view instead (`renderStorageSvg`).
- **PNG has no route of its own.** The button fetches `diagram.svg` and
  rasterises it on a canvas in the browser.
- **`signet visualise`** runs the same TypeScript as the site. The Go CLI
  embeds one JavaScript bundle of the package, built by
  `packages/visualiser/scripts/build-cli-bundle.mts`, so there is no second
  layout to drift. When the decision is `too-simple` or `too-large` it draws
  the function list alone.
- **The `signet dev` UI** draws a local build with `renderDiagramSvg`, but
  with no links. It adds a badge to whatever the build added or changed
  against the deployed interface, and marks from that session's own sandbox
  runs, labelled as local.

---

## Decisions

The questions this note left open that now have an answer.

- **Is a diagram the right primitive at all for a simple contract?** Not
  always, so there is a not-worth-drawing threshold: a graph with no
  spec-derived edges is not drawn (`MIN_EDGES`, §3). It sits at zero and has
  not been calibrated against real contracts.
- **Where does the mutate/read mark come from before phase 2?** Nowhere. The
  mark shipped observed-only and never as a heuristic. `classifyFunctions`
  gives a function `writes`, `no-writes-seen` or `unknown`, and the name and
  return-type guess (`get_*`, `-> Option`) is deliberately not implemented
  (`packages/spec/src/observe/classify.ts`).
- **How much interactivity is worth the static-rendering cost?** The
  server-rendered SVG is complete without JavaScript, and interactivity is
  added on top as progressive enhancers in
  `packages/visualiser/src/interactive/`: the detail card, keyboard
  navigation, expand and collapse in place, the filter, permalinks, the
  bounded viewport with zoom and pan, and PNG export.

## Still open

- **Does the diagram belong on the OpenGraph image?** Not decided. Neither
  link-preview image draws it today: not the contract's
  (`apps/web/app/p/[handle]/contract/[address]/opengraph-image.tsx`) and not
  the profile card's (`apps/web/app/p/[handle]/opengraph-image.tsx`). The
  constraint has not changed: the OG renderer is size- and complexity-bound
  and would need the collapsed view (§3) as its only mode.
- **A `/contract/{address}` route with no handle.** Not built. The same
  diagram is useful for any address, not only one on a profile, but every
  surface the site serves is under `/p/{handle}/contract/{address}`.
  `signet visualise` already draws any address from the command line.
