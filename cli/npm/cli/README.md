# @signet/cli

Zero-dependency npm wrapper for the `signet` CLI. `npx` executes JavaScript
and cannot run a Go binary directly, so this package is a small shim that
execs the prebuilt binary published for your platform:

```bash
npx @signet/cli link aquawolf --public-key G... --json
```

npm resolves exactly one of the following `optionalDependencies` for the
running platform/architecture — the others are skipped entirely, so nothing
you don't need is downloaded:

| Package | Platform |
|---------|----------|
| `@signet/cli-linux-x64` | Linux x64 |
| `@signet/cli-linux-arm64` | Linux arm64 |
| `@signet/cli-darwin-arm64` | macOS (Apple Silicon) |
| `@signet/cli-windows-x64` | Windows x64 |

Each platform package's version is pinned to exactly match this one — see
`scripts/release/pin-shim-version.mjs` in the main repo. Source, full docs,
and the underlying Go module: <https://github.com/blockchain-maxis/signet/tree/main/cli>.
