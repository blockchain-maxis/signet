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

## The `stellar` CLI dependency

`internal/keys` delegates identity resolution and signing to the [Stellar
CLI](https://developers.stellar.org/docs/tools/cli) (`stellar keys ...`,
`stellar tx sign ...`) rather than owning key storage itself.
`keys.CheckStellarCLI` verifies it's on `PATH` and reports at least
`keys.MinimumStellarVersion` (currently `25.2.0` — where `tx sign` gained
`--sign-with-key` and reading the transaction from stdin) before any command
that needs it does real work. A missing binary and a too-old version each
produce a distinct, actionable error naming
`keys.StellarInstallURL` and the required version — never a raw exec error or
an unrecognized-flag message pointing at the wrong tool.

## Commands

### `signet link <handle>`

```bash
signet link aquawolf --public-key GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD
# Linked aquawolf to GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD (testnet)
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

Stable and documented — scripts and CI wrapping this command can branch on
the code instead of scraping message text, which is free to change between
releases.

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Generic/unexpected error |
| `2` | Invalid input (e.g. a malformed handle or public key) |
| `3` | Configuration error — the config file, a flag/env var, or the local `stellar` CLI (missing, or older than the required minimum version) is unusable |
| `4` | No identity — `stellar` couldn't resolve the requested identity |
| `5` | Signing failed |
| `6` | Network error — a Signet deployment couldn't be reached, or returned an unexpected response |
| `7` | Timed out |
| `8` | Approval rejected — the developer (or the deployment, on their behalf) explicitly declined |
| `9` | Already linked — the target wallet already has a conflicting binding |

Codes `5`–`9` are defined now (`internal/exitcode`) so the commands that will
raise them (signing, talking to a deployment, an interactive approval flow)
have a stable code to wrap into from day one, even though nothing in this
module raises them yet. `0`–`4` all have a real caller today.

Every code beyond `2` is a sentinel error in `internal/exitcode`
(`ErrConfiguration`, `ErrNoIdentity`, etc.), wrapped with `fmt.Errorf`'s `%w`
wherever it actually happens and matched with `errors.Is` — see
`internal/cmd.ExitCode`. `2` is the one exception, implemented via
`link.ValidationError`'s own `ExitCoder` interface rather than a shared
sentinel, since malformed input is caught before any of the other failure
classes could apply. An error that matches neither mechanism maps to `1`.

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

## Layout

| Path | Purpose |
|------|---------|
| `cmd/signet` | `main.go` — the binary's entrypoint |
| `internal/cmd` | Cobra command tree |
| `internal/config` | Resolves `--url`/`--source`/`SIGNET_URL`/the config file into the settings a run uses |
| `internal/link` | `signet link` — validates a handle/public key and reports a structured result; the actual on-chain claim / API call is not yet implemented |
| `internal/keys` | Resolves a named local identity to its public key, and checks the local `stellar` CLI is present and new enough, by shelling out to it; signing itself is not yet implemented |
| `internal/spec` | Typed request/response models for a Signet deployment's HTTP API (scaffolded, not yet implemented) |
| `internal/exitcode` | The exit-code taxonomy (see "Exit codes" above) — its own leaf package so both `internal/cmd` and packages like `internal/keys` can depend on it without a cycle |
