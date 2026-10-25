# @signet/cli

Zero-dependency npm wrapper for the `signet` CLI. `npx` executes JavaScript
and cannot run a Go binary directly, so this package is a small shim that
execs the prebuilt binary published for your platform:

```bash
npx @signet/cli link alice --public-key G... --json
```

npm resolves exactly one of the following `optionalDependencies` for the
running platform/architecture — the others are skipped entirely, so nothing
you don't need is downloaded:

| Package | Platform |
|---------|----------|
| `@signet/cli-linux-x64` | Linux x64 |
| `@signet/cli-linux-arm64` | Linux arm64 |
| `@signet/cli-darwin-arm64` | macOS (Apple Silicon) |
| `@signet/cli-darwin-x64` | macOS (Intel) |
| `@signet/cli-windows-x64` | Windows x64 |

Each platform package's `bin/` holds two binaries: `signet` and
`signet-simulator`, the contract simulator `signet sandbox` and `signet dev`
run. signet finds the simulator next to itself, so nothing needs configuring;
`SIGNET_SIMULATOR_PATH` is only for development builds and non-standard
installs.

## The sandbox

`signet sandbox call`, `signet sandbox fork` and `signet dev` run contracts
locally on a fork of a network, in `signet-simulator`. It carries one Soroban
host per ledger protocol it supports (today 28 and 29), which is most of its
size: about 10.4 MB on Linux x64, stripped, against 6.8 MB for one protocol.
`npx @signet/cli sandbox doctor` shows which protocols it runs and whether your
networks are on one of them.

Each platform package's version is pinned to exactly match this one — see
`scripts/release/pin-shim-version.mjs` in the main repo. Source, full docs,
and the underlying Go module: <https://github.com/blockchain-maxis/signet/tree/main/cli>.
