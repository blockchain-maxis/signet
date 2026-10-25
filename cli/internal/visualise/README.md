# The visualiser the CLI embeds

`bundle/visualiser.js` is `@signet/visualiser` as one self-contained JavaScript
file (#544), for the Go CLI to run in [goja](https://github.com/dop251/goja), a
pure-Go engine that keeps the `CGO_ENABLED=0` builds working. There is one
layout, in TypeScript; the CLI does not reimplement it in Go.

It defines one global, `signetVisualise({ specJson, theme, address?, network?,
overlays? })`, which returns `{ svg, decision, wasmHash }` synchronously: the
standalone SVG of a contract's diagram from its `SpecJson` (which
`signet-simulator`'s `spec_extract` produces, #545), so it never parses WASM.
It reads no host globals; what the Stellar SDK reaches for (`Buffer`,
`TextEncoder`, `TextDecoder`) is built in.

It is generated and committed. Do not edit it; rebuild it after changing the
visualiser:

```sh
node --experimental-strip-types packages/visualiser/scripts/build-cli-bundle.mts
```

`node scripts/check-visualiser-bundle.mjs` (CI) fails when it is stale or over
its 2 MB budget, and the visualiser's tests check that, run with no globals at
all, it draws every fixture byte for byte as the package does.
