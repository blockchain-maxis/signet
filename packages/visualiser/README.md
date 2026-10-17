# @signet/visualiser

The pure, framework-free core of the contract diagram: decoded spec in, SVG
string out, with no DOM and no network. The design is
[`docs/CONTRACT_VISUALISER_DESIGN.md`](../../docs/CONTRACT_VISUALISER_DESIGN.md).

```sh
pnpm --filter @signet/visualiser test       # node:test over src/**/*.test.ts
pnpm --filter @signet/visualiser typecheck
pnpm --filter @signet/visualiser lint
```

Tests read the committed real-contract specs in [`fixtures/`](fixtures/README.md)
and never touch the network.

## Golden SVG snapshots

Determinism is the diagram's central promise: the same `wasmHash` draws the same
bytes everywhere (design §2.2). `src/golden.test.ts` renders every fixture and
compares the result byte for byte with `fixtures/__golden__/<name>.svg`, so any
change to the output shows up in review as a diff of the golden files.

Each fixture is rendered the way the contract page renders it: spec →
`buildContractGraph` → `layoutContractGraph` → `diagramDecision`, then
`renderDiagramSvg`.

- `draw`: the golden is the laid-out diagram, types and edges included.
- `too-simple` or `too-large`: there is no graph to draw, so the golden is the
  list-mode fallback: the function nodes alone, in the grouped column order,
  with no type nodes and no edges. `identity-registry` (no types) and
  `soroswap-router` (its structs are event payloads, which no signature
  reaches) are both `too-simple`; `blend-pool-v1` is drawn.

### When a golden test fails

The failure names the fixture, the first differing line in both versions, and
the command to update:

```text
blend-pool-v1: the rendered SVG differs from packages/visualiser/fixtures/__golden__/blend-pool-v1.svg.
first difference at line 93:
  golden:   "      width=\"999\""
  rendered: "      width=\"100\""
If the change is intended, update the golden with: UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test
```

1. Decide whether the change is intended. An unintended diff is a regression:
   fix the code, not the golden.
2. If it is intended, rewrite the goldens and commit them with the change:

   ```sh
   UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test
   git diff packages/visualiser/fixtures/__golden__/
   ```

   The diff is part of the review: it should show exactly what the change was
   meant to move, and nothing else.

### Adding or removing a fixture

A new `fixtures/<name>.spec.json` without a golden fails with the same update
command; run it to create the golden and commit both. `UPDATE_GOLDEN=1` also
deletes the golden of a fixture that no longer exists, and without it the
leftover golden fails the suite.

### Line endings

Goldens are compared byte for byte, so `.gitattributes` pins
`fixtures/__golden__/*.svg` to LF on every checkout. Without it, Git on Windows
with `core.autocrlf` would check them out with CRLF and every golden would fail
on line 1. A `\r` at the end of a line in the failure message means exactly
that.

### What the goldens pin today

`renderDiagramSvg` draws a positioned model at the layout's `x`/`y`, including
its group boxes and group headers. The goldens therefore pin node positions as
well as nodes, labels, links, ids, edges and the list-mode decision. A change
that moves a node changes the golden like any other output change. SVG edge
routing is still the renderer's straight port-to-port line; wiring in
`routeEdges` for the inline diagram remains #487/#493.

## Standalone SVG downloads

`renderStandaloneSvg(layoutContractGraph(buildContractGraph(spec)), { theme,
provenance: { address, network, wasmHash } })` returns an SVG document with its
own dimensions, canvas, one style block, and a provenance footer. `theme` is
`dark`, `light`, or `auto`; auto follows `prefers-color-scheme` in browsers and
falls back to light in editors without media-query support. Colours come from
`tokens.ts` and use literal CSS values so editors need no CSS-variable support.
The renderer uses the positioned layout and orthogonal routing passes. Labels
and provenance are XML-escaped; it emits no scripts, remote resources or links.

The web Diagram tab links to
`/p/{handle}/contract/{address}/diagram.svg?theme=auto`. Explicit `dark` and
`light` queries are useful for slide/report backgrounds. The attachment route
checks deployment attribution itself (layouts do not guard route handlers),
returns 404 for invalid/unattributed contracts, 503 for unavailable attribution
or interfaces, 400 for unsupported themes and 422 above the 60-node design
limit. It uses the resolved interface's WASM hash for provenance and does not
cache attribution or failed responses.

The route currently reuses the canonical cached spec resolver and computes the
pure layout. The versioned layout cache in #497 is still pending and should
replace that computation when available; this change adds no second cache.

## Server-first expand/collapse

The Diagram tab composes `layoutContractDiagram` from a decoded spec: type
depth (#490), then group collapse (#502), then layout. With no explicit
`collapsedGroups`, a contract above the 25-function collapse threshold starts
with every group collapsed to one node labelled like `pool_* (12)`. The page parses
`?expand=` and `?types=` against the spec's own names, so each collapsed group
is a plain link to the URL that expands it and the feature works without JS.

`@signet/visualiser/interactive/expand` upgrades those links: it fetches
`…/diagram/fragment?expand=…`, swaps the SVG, restores focus to the toggled
group and uses `history.replaceState`. A failed fetch navigates normally. The
fragment and the page render through the same `renderContractDiagram` path and
share its canonical per-state cache, so a permuted query hits the same entry.
