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

## Opening a browser

`internal/browser.OpenOrPrint(out, url, noBrowser)` is what a future
interactive approval flow (`signet link` opening a page for a human to
confirm) uses to show that page: it attempts the platform opener (`open` on
macOS, `xdg-open` on Linux, `rundll32 url.dll,FileProtocolHandler` on
Windows — Go has no stdlib opener, so this is an explicit per-OS call rather
than a dependency), and falls back to printing the URL to `out` instead —
never treating the opener's failure as fatal — when `noBrowser` is set, when
no display is detected (`DISPLAY`/`WAYLAND_DISPLAY` on Linux; macOS/Windows
are assumed to always have one), or when the platform opener itself fails to
launch (e.g. it isn't installed). Both paths reach the developer at exactly
the same URL.

Not yet wired into any command: `link` doesn't perform a real approval flow
yet (see "Commands" below), so there's nothing to open a browser to. The
package is built and tested ahead of that landing, same as `internal/keys`
and `internal/spec`.

## Commands

### `signet link`

Attaches the wallet you deploy contracts from to your Signet handle.

```bash
signet link
# Approve this link in your browser:
#
#     https://signet.example/link?callback=…&code=…&user_code=…
#
# The approval page will show this code: ABCD2345
#
# Waiting for approval… 4m58s remaining
# Approved. Proving control of the deploy key…
# Linked GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U to @alice on testnet.
```

There is no handle argument: the handle is whichever one you are signed in as
when you approve in the browser. Asking for it here would invite typing one you
do not own, and the server would refuse it anyway. There is no `--public-key`
either — the key is resolved from your local `stellar` identity, so what gets
signed and what gets linked cannot disagree.

Approving proves you own the handle; signing a challenge proves you control the
deploy key. Both are required.

`--json` writes a single JSON object to stdout instead — `{handle, publicKey,
network, status}` — and sends progress to stderr, so a CI pipeline can parse
the result without scraping text that is free to change between releases:

```bash
signet link --json
# {"handle":"alice","publicKey":"GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U","network":"testnet","status":"linked"}
```

`--no-browser` prints the approval URL instead of trying to open one.
`--network` defaults to `testnet`; pass `--network mainnet` for mainnet.

If the browser cannot reach the CLI's local callback and stdin is a terminal,
`link` asks you to paste the code the approval page shows (it appears straight
away if the callback port could not be opened, otherwise 10 seconds after the
approval is seen). Whichever finishes first wins. With `--json`, or when stdin
is not a terminal, it never prompts.

Ctrl-C while waiting prints `pairing abandoned; the link expires at …` to stderr
and exits `130`. Linking a wallet that is already bound to your handle reports
`status: "already-linked"` instead of `"linked"`.

### `signet whoami`

```bash
signet whoami
# identity:   deploy
# publicKey:  GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U
# deployment: https://signet.example
# handle:     @alice
```

Answers "which account am I actually linked as?". `--json` emits
`{identity, publicKey, deployment, handle, linked}`. Never prints a secret —
the public key is resolved through `stellar keys address`.

### `signet unlink`

Removes the binding, proving control of the same deploy key.

```bash
signet unlink
# Unlink GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U from @alice? [y/N] y
# Unlinked GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U from @alice.
```

Before asking, it looks the key up (the same query as `signet whoami`), so the
prompt names the handle the key feeds. A key that isn't linked is told so, and
the command exits `0` without fetching or signing a challenge.

`--yes` skips the confirmation, and is **required** when stdin is not a
terminal: without it, a non-interactive run exits `2` ("unlink needs --yes when
not run interactively") before any network call, instead of reading end of
input as "no" and exiting `0` as if it had worked. Unlinking needs only
key control — no browser step — because it withdraws an attestation rather than
making one.

On any failure stdout stays empty (in both modes) and the error goes to stderr
with a non-zero exit code — stdout is always safe to parse as either the one
JSON object or nothing at all.

### `signet sandbox fork`

```sh
signet sandbox fork CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
# Forked CASF…RCN on testnet at ledger 4887004 (protocol 28, 3s ago) · wasm 9369…fe · instance storage 3 entries
```

Pins a fork of a deployed contract at the network's latest ledger. The
contract simulator opens a ledger at that sequence and reads the contract
without running it; every entry it needs (the network's `ConfigSetting`
entries, the contract's instance, a CAP-85 executable reference, the code) is
fetched from RPC and kept in the fork cache under `os.UserCacheDir()/signet/forks/`.
`--json` prints the fork's manifest.

- An account address (`G…`/`M…`) or anything that is not a valid `C…` strkey
  exits `2`, before any network call; so does a contract the network does not
  have at that ledger (and no fork is kept).
- A network running a ledger protocol the bundled simulator has no lane for
  exits `11`, naming both.
- An RPC serving another network than `--network` exits `3` (see "Sandbox
  network and RPC" below).

RPC only serves the latest state, so an entry fetched after the fork ledger may
have changed since. Such an entry is _drifted_: the fork would mix ledgers that
never existed together. `--drift` (shared by the sandbox commands) decides what
happens: `warn` (the default) prints
`⚠ 2 entries changed on-chain after the fork ledger; results mix ledger 4852095 and 4852131`,
`fail` exits `6`, and `refork` pins the latest ledger and runs once more. The
manifest records `driftedEntries`.

### `signet sandbox call`

```sh
signet sandbox call CASF…RCN count
# → 41
# ⚠ auth mocked: signatures were not checked
# ran against testnet · fork ledger 4887004 (3s ago) · protocol 29 lane · no drift · auth mocked
signet sandbox call CASF…RCN claim --arg handle=alice --arg wallet=GA5Z…
# Would write 3 entries · requires auth from GA5Z…ZVN (claim)
# Local sandbox: nothing was submitted to testnet
signet sandbox call CASF…RCN claim --arg handle=alice --arg wallet=GA5Z… --session demo
signet sandbox call CASF…RCN resolve --arg handle=alice --session demo
signet sandbox session reset demo
```

Calls a function on the newest fork of the contract (forking it first if there
is none) in the local simulator. Nothing is submitted.

- `--arg name=value` is read as JSON when it parses and as a plain string
  otherwise (`--arg n=5` is a number, `--arg handle=alice` a string); quote a
  string that looks like JSON. `--args-file` takes a JSON object.
- `--source-account G…` is the account the call runs as. It is deliberately not
  `--source`, the root flag naming the `stellar` identity, which the config file
  remembers.
- `--session <name>` keeps the call's writes in the fork cache and starts the
  next call with that name from them; without it every call starts from the
  fork. `signet sandbox session reset <name>` forgets them.
- `--wasm ./x.wasm` swaps a local build in first, as an upgrade would, keeping
  storage.
- `--auth` decides how `require_auth` is answered. `record` (the default)
  approves every one and lists who would have had to sign, for which function,
  with `⚠ auth mocked: signatures were not checked`: a call you hold no keys
  for still runs. `strict` also refuses auth required below the root call,
  which the network refuses when no entry covers it; it matters for custom
  accounts and nested auth. `enforce --auth-entries file.json` checks
  pre-signed entries (a JSON array of base64 `SorobanAuthorizationEntry`, e.g.
  from `stellar`); signet signs nothing.
- `--ledger-seq N` and `--timestamp <unix|RFC 3339>` run the call at another
  ledger; `--advance 30d` (or `12h`, `+N` ledgers) moves both from the fork's,
  taking a ledger as the network's nominal 5s, which is an approximation. The
  session's own ledger stays put. An entry whose TTL runs out on the way is
  named: a persistent one (`⚠ archived: …`) is restored by the call, as the
  network does from protocol 23, for a restore fee, so the call now writes it;
  a temporary one (`⚠ expired: …`) reads as absent. `--unlimited` runs under
  the sandbox's budget ceiling, 10x the network's limits, and
  `--budget-instructions N` sets the instruction limit; on the network the call
  would still need to fit. Each override is in the footer.
- Calls reach other contracts (a token, an oracle). Whatever the call reads is
  fetched as it reads it, and each other contract it reaches is recorded in
  the fork's manifest (`contracts`), said once:
  `+ pulled in CB64…XYZ (native SAC)`. The next run of the same function
  fetches everything earlier runs needed in one batch before it starts, even
  on a new fork of the contract. `--no-related` keeps a run to this contract:
  reaching any other is an error that names it.
- A Stellar Asset Contract's code is built into the host, so nothing is
  fetched for it; its instance, balances and trustlines are fetched when read.
  Like `stellar snapshot create`, a fork holds only the holders' entries the
  call read, never every trustline of an asset.
- A result reads as one of three things: a read (`→ value`: nothing written,
  no auth), a write preview (what it would write and who would have to sign,
  and that nothing was submitted), or the contract refusing, by name. Host
  errors (budget, traps), simulator failures and timeouts each have their own
  wording, and every result ends with what it ran against: network, fork
  ledger and age, lane, drift, overrides, and that auth was mocked. Colour only
  on a terminal, never with `NO_COLOR`.
- A contract that refuses the call (`✗ HandleTaken (#3): …`) is an answer, not a
  failure: exit `0`. An unknown function or a bad argument exits `2`, naming the
  functions or the argument; a simulator failure exits `13`.
- `--json` writes one object, `sandbox/protocol/schema/v1/cli-call-result.json`.

### `signet sandbox forks`

```sh
signet sandbox forks ls                 # ID, network, ledger, age, entries, size, drift (--json too)
signet sandbox forks rm CASF…RCN@4887004
signet sandbox forks rm --older-than 7d # also 2w, 36h; asks first
signet sandbox forks rm --all --yes     # --yes is required when stdin is not a terminal
signet sandbox forks refresh CASF…RCN@4887004
```

`refresh` forks the same contract again, on the same network and RPC, at the
latest ledger; the old fork stays until removed. Saved calls live in
`signet.dev.toml`, not the cache, so they carry over. A fork another process
has open shows as `in use` and is not removed.

### Global `--json`

`--json` is a persistent flag on the root, so it works on every command and
means the same thing everywhere: **stdout carries exactly one JSON object, or
nothing**. Human-readable output goes to stdout only without `--json`;
diagnostics (progress lines, prompts, warnings) go to stderr under `--json`.
On any failure stdout stays empty and the error goes to stderr with a non-zero
exit code. `signet version --json` prints `{version, commit}`; `signet identity
--json` prints `{identity, publicKey}`.

Without `--json`, `signet link` still prints its progress on stdout, as before.

### Non-interactive use (CI)

An interactive identity prompt has nothing to answer it in CI. Set the identity
and no prompt appears:

```bash
# stellar already reads this for `tx sign`; signet honours the same variable,
# so there is only one name to keep in sync.
export STELLAR_SIGN_WITH_KEY=ci-deploy
signet link --json
```

or per-invocation:

```bash
signet link --sign-with-key ci-deploy --json
```

Pass an **identity name**, not a secret. signet resolves your public key with
`stellar keys address <name>` before it can request a challenge — that is how
key material stays out of this process — and a secret on the command line is
visible in shell history and to anyone who can run `ps`. A value that looks
like a secret seed or a seed phrase is refused, and the value is never echoed
back in the error. Add the key once in the job and pass its name:

```bash
stellar keys add ci-deploy --secret-key "$SIGNET_DEPLOY_KEY"
```

Unlike `--source`, neither `--sign-with-key` nor `STELLAR_SIGN_WITH_KEY` is
written to the config file.

## Adding a command

Commands are grouped in `signet --help` (_Identity & linking_, _Deployments_,
_Contracts_, _Other_) and register themselves, so a new command is a one-file
change:

1. Create `internal/cmd/<name>.go` with a constructor that takes no arguments:

   ```go
   func init() { register(groupContracts, newDevCmd) }

   func newDevCmd() *cobra.Command {
       return &cobra.Command{
           Use:  "dev",
           Args: cobra.NoArgs,
           RunE: func(cmd *cobra.Command, _ []string) error {
               deps, err := depsFor(cmd)   // Config, NewClient, KeysBinary
               if err != nil {
                   return err
               }
               printer := printerFor(cmd)  // honours the global --json
               // ... do the work, report with printer.Progress(...) ...
               return printer.Result(result, func(w io.Writer) error {
                   _, err := fmt.Fprintln(w, "human text")
                   return err
               })
           },
       }
   }
   ```

2. Pick the group with `register`: `groupIdentity`, `groupDeployments`,
   `groupContracts` or `groupOther` (`commands.go`). A group with no commands is
   left out of `--help`; _Contracts_ appears with the first command registered
   into it.
3. Output goes through `internal/output`, never `fmt.Print*` on stdout: call
   `Printer.Result` once with the value and a human renderer, and
   `Printer.Progress` for anything printed on the way. Do not declare your own
   `--json`; the root's applies.
4. Reach `stellar`, the API client and the resolved configuration only through
   `Deps` (`depsFor(cmd)`), so a test can substitute fakes.
5. Add the command to `failing` (or `cannotFail`) in
   `internal/cmd/structure_test.go`; that test then checks it belongs to a
   group and writes nothing to stdout when it fails under `--json`.

## Exit codes

Stable and documented — scripts and CI wrapping this command can branch on
the code instead of scraping message text, which is free to change between
releases.

| Code  | Meaning                                                                                                                                                                                                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | Success                                                                                                                                                                                                    |
| `1`   | Generic/unexpected error                                                                                                                                                                                   |
| `2`   | Invalid input (e.g. a malformed handle or public key, or `unlink` run non-interactively without `--yes`)                                                                                                   |
| `3`   | Configuration error — the config file, a flag/env var, the local `stellar` CLI (missing, or older than the required minimum version), or the contract simulator (`signet-simulator` not found) is unusable |
| `4`   | No identity — `stellar` couldn't resolve the requested identity                                                                                                                                            |
| `5`   | Signing failed                                                                                                                                                                                             |
| `6`   | Network error — a Signet deployment couldn't be reached, or returned an unexpected response                                                                                                                |
| `7`   | Timed out                                                                                                                                                                                                  |
| `8`   | Approval rejected — the developer (or the deployment, on their behalf) explicitly declined                                                                                                                 |
| `9`   | Already linked — the target wallet already has a conflicting binding                                                                                                                                       |
| `10`  | Diff found — a sandbox comparison found a difference; a finding, not a failure (like `grep`'s exit 1)                                                                                                      |
| `11`  | Host unsupported — the simulator can't serve this network (protocol version, host functions, or network id it doesn't model)                                                                               |
| `12`  | Build failed — the contract under test failed to build, so there was nothing to run                                                                                                                        |
| `13`  | Simulator failure — the simulator itself failed, as opposed to a contract call failing inside a working simulator (the distinction `docs/CLI_RUST_BRIDGE.md` §3 keeps)                                     |
| `130` | Interrupted — the developer pressed Ctrl-C while the command was waiting (for example `link` abandoning a pairing)                                                                                         |

Every code has a real caller now: `link` and `unlink` raise `3`–`9` between
them (configuration, identity resolution, `stellar tx sign`, reaching the
deployment, the approval wait, a refusal, and a wallet already bound
elsewhere). See [`docs/CLI.md`](../docs/CLI.md) for a symptom → cause → fix
table keyed to them.

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

1. A command-line flag: `--url` / `--source` / `--sign-with-key`
   (`--sign-with-key` outranks `--source`: it is the more specific statement
   of intent)
2. An environment variable: `SIGNET_URL` for the deployment URL,
   `STELLAR_SIGN_WITH_KEY` for the identity
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
invocation doesn't have to repeat it. `--sign-with-key` and
`STELLAR_SIGN_WITH_KEY` deliberately do not — `stellar tx sign` accepts key
material for that setting, and persisting a secret to disk on your behalf is
not signet's call — that's what makes repeat runs not
re-ask which identity to use. `--url` is read from the config file but never
written back by a flag; edit the file (or keep using `--url`/`SIGNET_URL`) to
change the configured deployment. See `internal/config` for the resolution
logic and its tests.

### Sandbox network and RPC

`signet sandbox` (and `signet dev`) fork contract state from a Stellar RPC.
They take the root's `--network` (`testnet`, `mainnet`, `futurenet`, `local`,
or a name of your own) plus two flags of their own:

| Flag                          | Meaning                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--rpc-url <url>`             | The RPC to fork from. Outranks the context's `rpc-url`.                                                        |
| `--network-passphrase <text>` | Required for a custom `--network`. For a known network it must equal that network's passphrase, or is refused. |

The RPC URL is `--rpc-url`, then the context's `rpcUrl` field, then
`https://soroban-testnet.stellar.org` for testnet only. Mainnet has no bundled
default, so it needs `--rpc-url` or a saved URL:

```sh
signet config set rpc-url https://my-mainnet-rpc.example
```

which stores it on the current context:

```json
{ "contexts": { "default": { "network": "mainnet", "rpcUrl": "https://my-mainnet-rpc.example" } } }
```

Before forking, signet calls the RPC's `getNetwork` and refuses (exit `3`) an
RPC whose passphrase is not the selected network's, so testnet state is never
labelled mainnet. RPC calls retry `429` and `5xx` with jittered backoff; a
call that runs out of time exits `7`, any other RPC failure `6`
(`internal/rpc`).

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

### Golden files

Scripts parse `--json` output and people read the human output, so both
change only on purpose. `internal/cmd/golden_output_test.go` runs real
invocations and compares everything each one produces (stdout, stderr, and
the error with its exit code) byte for byte against
`internal/cmd/testdata/golden/*.golden`. It covers `--help` for every command,
`link` (approved, rejected and expired), `unlink` and `whoami` (linked and not
linked), `doctor` (all green and one failure) in both human and `--json`
form, and the network-mismatch message.

When a change to the output is deliberate, regenerate the goldens and commit
them with the change:

```bash
go test ./internal/cmd -update
git diff internal/cmd/testdata/golden   # review it like code
```

Without `-update`, any difference fails the test with a line diff (`-` the
golden, `+` the new output). The `-update` flag is defined only in
`internal/cmd`, so pass it to that package rather than to `./...`.

Anything that changes between runs or machines is normalised by the helper
(`normalizeGolden` in `internal/cmd/golden_test.go`), never edited by hand in a
golden: random ports become `127.0.0.1:<port>`, the callback nonce becomes
`<state>`, timestamps become `<timestamp>`, the temp directory becomes `<tmp>`,
and the build version and the minimum `stellar` version become `<version>` and
`<stellar-version>`. To cover a new volatile value, add a pattern there.
`\r\n` is read as `\n`, and `.gitattributes` keeps the goldens LF, so the same
files pass on Linux, macOS and Windows in CI.

No cgo is used anywhere in this module, so it cross-compiles with the
standard `GOOS`/`GOARCH` combinations, e.g.:

```bash
GOOS=darwin GOARCH=arm64 go build -o bin/signet-darwin-arm64 ./cmd/signet
GOOS=linux  GOARCH=amd64 go build -o bin/signet-linux-amd64  ./cmd/signet
```

## Layout

| Path                 | Purpose                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd/signet`         | `main.go` — the binary's entrypoint                                                                                                                                                                                                                                                                                                                         |
| `internal/cmd`       | Cobra command tree                                                                                                                                                                                                                                                                                                                                          |
| `internal/config`    | Resolves `--url`/`--source`/`SIGNET_URL`/the config file into the settings a run uses                                                                                                                                                                                                                                                                       |
| `internal/link`      | `signet link` — validates a handle/public key and reports a structured result; the actual on-chain claim / API call is not yet implemented                                                                                                                                                                                                                  |
| `internal/keys`      | Resolves a named local identity to its public key, and checks the local `stellar` CLI is present and new enough, by shelling out to it; signing itself is not yet implemented                                                                                                                                                                               |
| `internal/spec`      | Typed request/response models for a Signet deployment's HTTP API (scaffolded, not yet implemented)                                                                                                                                                                                                                                                          |
| `internal/output`    | The shared output layer: `Printer{JSON, Out, Err}` with `Result` (one JSON object or the human rendering), `Progress` and `Interactive` (stdout for a person, stderr under `--json`)                                                                                                                                                                        |
| `internal/exitcode`  | The exit-code taxonomy (see "Exit codes" above) — its own leaf package so both `internal/cmd` and packages like `internal/keys` can depend on it without a cycle                                                                                                                                                                                            |
| `internal/browser`   | Opens a URL in the default browser for an approval flow, falling back to printing it — not yet wired into any command                                                                                                                                                                                                                                       |
| `internal/simulator` | The one client for `signet-simulator`: finds it (`SIGNET_SIMULATOR_PATH`, beside `signet`, then `PATH`), spawns it, checks the handshake, serialises calls, answers its `ledger_fetch`, enforces the per-request timeout (SIGTERM, 2s, SIGKILL), stops it when idle, and respawns it transparently with the session replayed (docs/CLI_RUST_BRIDGE.md §4–5) |
| `internal/rpc`       | A thin Stellar RPC JSON-RPC client (`getNetwork`, `getLatestLedger`, `getVersionInfo`, `getHealth`, `getLedgerEntries` paged at 200 keys, `getTransaction(s)`, `getEvents`, `simulateTransaction`) with retries, and the sandbox network selection; payloads stay base64                                                                                    |
| `internal/fork`      | The on-disk fork cache: one bbolt database per network and `<contract>@<forkLedger>` under `os.UserCacheDir()/signet/forks/`, with a `manifest.json`, a single-process lock that names the owning PID, and corruption detection                                                                                                                             |
