# signet CLI

The `signet` command-line companion to the Signet developer identity registry
on Stellar/Soroban. It lives beside the pnpm workspace rather than inside it —
this is a standalone Go module, not a pnpm package — mirroring the split
between orchestration/UX (Go, here) and anything that must execute Soroban
semantics (Rust, `packages/contracts`).

This module is currently a scaffold: the command tree, configuration, and
identity resolution exist, and `link` validates its inputs and reports a
structured result, but it doesn't yet perform a real on-chain claim or call a
deployment's HTTP API — that (along with local key management) lands in
follow-up issues once `internal/keys`/`internal/spec` are implemented.

## Commands

### `signet link <handle>`

```bash
signet link aquawolf --public-key GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD
# Validated aquawolf for GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD (testnet). Not yet submitted — the on-chain claim is not implemented.
```

`--json` writes a single JSON object to stdout instead — `{handle, publicKey,
network, status}` — and suppresses the human-readable summary entirely, so a
CI pipeline can parse the result without scraping text that's free to change
between releases:

```bash
signet link aquawolf --public-key GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD --json
# {"handle":"aquawolf","publicKey":"GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD","network":"testnet","status":"ok"}
```

On an invalid handle or public key, stdout stays empty (in both modes) and
the error goes to stderr with a non-zero exit code — stdout is always safe
to parse as either the one JSON object or nothing at all.

`--network` defaults to `testnet`; pass `--network mainnet` for mainnet.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Generic/unexpected error |
| `2` | Invalid input (e.g. a malformed handle or public key) |

Any error not tagged with a specific code (see `internal/cmd.ExitCoder`) maps
to `1`. Diagnosed from a CI log or a shell script's `$?` — there's no preview
deploy or browser console for a CLI once it ships as a binary.

## Configuration

Every command reads two settings — which Signet deployment to talk to, and
which local identity to sign as — resolved in this order, highest priority
first:

1. A command-line flag: `--url` / `--source`
2. An environment variable: `SIGNET_URL` (for the deployment URL only —
   there is no environment override for the identity)
3. The config file: `$XDG_CONFIG_HOME/signet/config.json` on Linux,
   `~/Library/Application Support/signet/config.json` on macOS,
   `%AppData%\signet\config.json` on Windows (`os.UserConfigDir()`)
4. The built-in default deployment — no config file is required to use it

```json
{
  "baseUrl": "https://my-self-hosted-signet.example",
  "source": "alice"
}
```

Passing `--source` explicitly updates the config file's `source` so the next
invocation doesn't have to repeat it — that's what makes repeat runs not
re-ask which identity to use. `--url` is read from the config file but never
written back by a flag; edit the file (or keep using `--url`/`SIGNET_URL`) to
change the configured deployment. See `internal/config` for the resolution
logic and its tests.

## Build

```bash
cd cli
go build -o bin/signet ./cmd/signet
```

To bake a version string and commit hash into the binary:

```bash
go build \
  -ldflags "-X main.version=$(git describe --tags --always) -X main.commit=$(git rev-parse --short HEAD)" \
  -o bin/signet ./cmd/signet
```

## Test / lint

```bash
go vet ./...
go test -race ./...
golangci-lint run ./...
```

`-race` needs a C toolchain (cgo) to build the instrumented test binary —
unrelated to the production build's `CGO_ENABLED=0` requirement below, since
the test binary is never distributed. If you don't have a C compiler
installed, drop `-race` locally; CI (`ubuntu-latest`) always runs with it.

`internal/keys`' tests compile a throwaway `stellar` CLI stand-in from
`internal/keys/testdata/fakestellar` on first use (the standard Go
"helper binary" pattern) so `ResolvePublicKey`'s `exec.Command` wiring is
exercised for real, without needing the actual Stellar CLI installed.

No cgo is used anywhere in this module, so it cross-compiles with the
standard `GOOS`/`GOARCH` combinations, e.g.:

```bash
GOOS=darwin GOARCH=arm64 go build -o bin/signet-darwin-arm64 ./cmd/signet
GOOS=linux  GOARCH=amd64 go build -o bin/signet-linux-amd64  ./cmd/signet
```

## Release

`npx` executes JavaScript from the npm registry and cannot run a Go binary
directly, so `npx @signet/cli link ...` works via a small wrapper package
(`npm/cli`) that execs the one prebuilt platform binary npm resolved as an
`optionalDependency` — the same pattern esbuild, swc, and turbo use:

```
npm/cli                    zero-dependency JS shim that execs the binary
  optionalDependencies:
    npm/cli-linux-x64       one prebuilt Go binary each, published from
    npm/cli-linux-arm64     the matching cli/npm/cli-<platform> package
    npm/cli-darwin-arm64
    npm/cli-windows-x64
```

Pushing a `cli-v*.*.*` tag (e.g. `cli-v0.1.0`) runs
[`.github/workflows/release-cli.yml`](../.github/workflows/release-cli.yml):
cross-compiles all four targets (Go cross-compiles cleanly from one runner —
no build matrix needed), checksums them, stages each binary into its npm
package via `scripts/release/stage-platform-package.mjs`, pins the shim's own
version and every `optionalDependency` to match via
`scripts/release/pin-shim-version.mjs` (so it never resolves a floating range
that could drift from what was actually tested), and creates a GitHub Release
with the binaries and checksums attached. That much runs on every tag push.

Actually publishing to npm is opt-in, mirroring `deploy.yml`: it runs only
when the `CLI_RELEASE_ENABLED` repository variable is `"true"` and an
`NPM_TOKEN` secret (npm automation token with publish access to `@signet`)
is configured in the `production` environment. Until then, tagging a release
still produces verified, checksummed binaries on the GitHub Release — nothing
publishes to npm without both being set deliberately.

## Layout

| Path | Purpose |
|------|---------|
| `cmd/signet` | `main.go` — the binary's entrypoint |
| `internal/cmd` | Cobra command tree |
| `internal/config` | Resolves `--url`/`--source`/`SIGNET_URL`/the config file into the settings a run uses |
| `internal/link` | `signet link` — validates a handle/public key and reports a structured result; the actual on-chain claim / API call is not yet implemented |
| `internal/keys` | Resolves a named local identity to its public key by shelling out to the `stellar` CLI (`stellar keys address <name>`); signing itself is not yet implemented |
| `internal/spec` | Typed request/response models for a Signet deployment's HTTP API (scaffolded, not yet implemented) |
| `internal/exitcode` | Process exit code constants, shared by `internal/cmd` and error types like `internal/link.ValidationError` |
| `npm/cli` | The `@signet/cli` npm shim published for `npx` |
| `npm/cli-<platform>` | One `optionalDependency` package per release target, each carrying just the prebuilt binary |
