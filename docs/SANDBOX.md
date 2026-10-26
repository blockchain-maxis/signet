# The contract sandbox

The sandbox runs a deployed Soroban contract's functions on your machine,
against a fork of the network, and compares a new build of it with the
deployed code before you ship. This page is the user guide: what it does,
how to install it, every command and setting, and where its answers stop
being trustworthy. The design is in
[`CONTRACT_SANDBOX_DESIGN.md`](CONTRACT_SANDBOX_DESIGN.md), the CLI ↔
simulator protocol in [`CLI_RUST_BRIDGE.md`](CLI_RUST_BRIDGE.md), and the
command reference in [`cli/README.md`](../cli/README.md#signet-sandbox-fork).

- [What it is, and what it is not](#what-it-is-and-what-it-is-not)
- [Install](#install)
- [Forks and calls](#forks-and-calls)
- [`signet dev`](#signet-dev)
- [`signet.dev.toml`](#signetdevtoml)
- [`signet dev --ci`](#signet-dev---ci)
- [Repro bundles](#repro-bundles)
- [Localnet](#localnet)
- [Protocol support](#protocol-support)
- [Troubleshooting](#troubleshooting)

New to it? [The tutorial](SANDBOX_TUTORIAL.md) forks Signet's own registry
and catches a breaking change in it, with real output.

## What it is, and what it is not

It is local: every call runs in `signet-simulator`, the contract simulator
that ships with `signet`, on a copy of the contract's ledger entries fetched
from a Stellar RPC and pinned at one ledger. Nothing is ever submitted, no
transaction is signed, and no account is charged. Every result says which
ledger it ran against.

It is not the network. A fork is a snapshot: the chain moves on, and an
answer is only as current as the fork's ledger (see
[drift](#lazy-and-archive-forks-drift)). Signatures are not checked unless
you ask (`--auth enforce`). Fees are the simulator's estimate, measured
against the RPC's own in [fidelity](#fidelity-against-the-network). And it
runs only the ledger protocols it carries a host for
([lanes](#protocol-support)).

## Install

`signet` and `signet-simulator` always travel together; signet finds the
simulator next to its own binary.

- **npm**: `npm install -g @signet/cli` (or `npx @signet/cli …`). The package
  pulls in exactly one platform package with both binaries: Linux x64 and
  arm64, macOS arm64 and x64, Windows x64.
- **GitHub Release**: `signet-<version>-<platform>.tar.gz` (`.zip` on
  Windows) holds `signet` and `signet-simulator` side by side; put both on
  `PATH`, together. `checksums.txt` covers the archives.

What else each part needs:

| For                                    | You need                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `signet sandbox fork`, `call`, `state` | a Stellar RPC (testnet has a default; set `--rpc-url` for any other)                                                       |
| `signet dev`                           | the `stellar` CLI (25.2.0 or newer), Rust with `cargo`, and the `wasm32v1-none` target (`rustup target add wasm32v1-none`) |
| `--localnet` (planned)                 | Docker                                                                                                                     |

`signet sandbox doctor` checks all of it at once: the simulator's lanes
against your networks' protocols, and the `stellar`, `cargo` and Docker
versions. `SIGNET_SIMULATOR_PATH` points signet at another simulator build,
for development.

## Forks and calls

```bash
signet sandbox fork CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
signet sandbox call CASF…RCN count
signet sandbox call CASF…RCN resolve --arg handle=alice
```

`signet sandbox fork <contract>` pins the network's latest ledger and caches
what a call needs to start: the contract's instance, its executable and the
network config. `signet sandbox call <contract> <function>` runs one function
on the fork and prints its return value, events, storage writes, the auth it
required and its cost; `--json` writes the whole result. `signet sandbox
state <contract>` lists the contract's storage entries the fork knows.

The network is `--network` (testnet by default) and its RPC `--rpc-url`, the
context's `rpc-url`, or testnet's public one; mainnet has no default. Before
forking, signet checks the RPC serves the network's passphrase.

- **Arguments** are named: `--arg handle=alice --arg wallet=G…`, each read as
  JSON when it parses as JSON and as a plain string otherwise; `--args-file`
  takes a JSON object. They are encoded with the contract's spec, so a wrong
  name or type is refused before anything runs.
- **Sessions**: without `--session` every call starts from the fork. With
  `--session demo` a call's writes are kept, and the next call with the same
  name starts from them; `signet sandbox session reset demo` forgets them.
- **Overrides** change storage for one call: `--set-storage
persistent:'Owner("alice")'='"G…"'`, `--unset-storage instance:count`, or a
  TOML file of `[[override]]` tables with `--overrides` (the same tables as
  [`signet.dev.toml`](#signetdevtoml)).
- **Auth modes** (`--auth`): `record`, the default, approves every
  `require_auth` and lists who would have to sign, without checking
  signatures; `strict` also refuses auth required below the root invocation;
  `enforce` checks the pre-signed entries given with `--auth-entries`.
  `--source-account` is the account the call runs as.
- **Time**: `--ledger-seq` and `--timestamp` set the ledger a call runs at;
  `--advance 30d` (or `12h`, or `+N` ledgers) moves both from the fork's, at a
  nominal 5 seconds a ledger. An entry whose TTL runs out on the way reads as
  archived: the call restores it, as the network does from protocol 23, and
  says so.
- **Budget**: `--unlimited` lifts the limits to the sandbox's ceiling (10x
  the network's); `--budget-instructions` sets the instruction limit.
- **A local build**: `--wasm ./target/wasm32v1-none/release/x.wasm` swaps it
  in first, as an upgrade would, keeping storage. `--save` appends the call
  to `signet.dev.toml` as a saved call.

### Lazy and archive forks, drift

A fork is **lazy**: entries arrive as something reads them, so it knows only
those keys, and entries fetched later can come from later ledgers. Each fetch
is checked against the fork's ledger: an entry changed on-chain after it is
**drift**, which `--drift` turns into a warning (`warn`, the default), a
failure (`fail`, exit 6) or a new fork at the latest ledger (`refork`).

A lazy fork knows only the keys something has read and can mix ledgers.
`signet sandbox fork <C…> --archive` instead imports every entry of the
contract at a history-archive checkpoint through `stellar snapshot create`
(#554). It is slow: when this was planned, `stellar snapshot create` on testnet
ran for 3 minutes 27 seconds before a bucket download failed. A failed snapshot
is retried once; after that the lazy fork, which needs no archive, is the way
on.

Forks are cached under your user cache directory (`~/.cache/signet/forks` on
Linux), one per network and contract. `signet sandbox forks ls` lists them
with their age, size and drift, `signet sandbox forks refresh` forks the same
contract again at the latest ledger, and `signet sandbox forks rm` removes
one, `--all`, or those `--older-than 7d`.

## `signet dev`

`signet dev <contract> --path ./contract` is the development loop: it builds
the local contract, runs its saved calls on the deployed and the new code from
the same forked state, and compares them, every time the source changes. The
contract, `--path` and `--package` come from the flags, or for what they leave
out from the nearest `signet.dev.toml`.

Before anything starts it checks the toolchain, in this order, and stops at the
first missing piece with what to do about it:

1. the `stellar` CLI, at least the version signet needs;
2. `cargo`;
3. the `wasm32v1-none` Rust target (`rustup target add wasm32v1-none`);
4. a contract crate at `--path`: a `Cargo.toml` with a `cdylib` crate (and,
   in a workspace with several, the one `--package` names);
5. the `signet-simulator`;
6. a simulator lane for the network's ledger protocol.

The first five exit `3`; a protocol no lane runs exits `11`. Then it forks the
contract and prints what it runs against:

```text
signet dev · CASF…RCN @ testnet ledger 4852095 · lane p28 · crate identity-registry
```

It builds with `stellar contract build --manifest-path <path>/Cargo.toml
--package <crate>`, leaving `CARGO_TARGET_DIR` alone so cargo's incremental
builds are reused, and takes the WASM from cargo's target directory
(`wasm32v1-none/release/<crate>.wasm`). A newer change cancels a build in
flight: its whole process group is killed and waited for before the next one
starts. A failed build shows rustc's first error block and how many more there
were, and the previous WASM stays in use; a build that leaves an artifact older
than itself is refused rather than run stale. `--ci` runs once and makes a
failed build exit `12`.

Without `--ci` it then watches until Ctrl-C (#565): the crate directory, new
subdirectories included, the workspace `Cargo.toml` and `Cargo.lock`, and
`signet.dev.toml`. `target/`, `.git/`, `.signet/` and editor swap and backup
files (`*.swp`, `*~`, `.#*`) are ignored. A burst of changes rebuilds once it
has settled for `--debounce` (150ms by default), since one editor save is
several filesystem events; a change to `signet.dev.toml` alone replays the
calls on the current build without rebuilding.

### The local UI

`signet dev --ui` also serves a web UI from the developer's machine (#576) and
opens it; `--no-browser` prints its URL instead. The server listens on
`127.0.0.1` only, the link carries a per-run token in its fragment (so it
never reaches a log), and the UI sends it back as a header: no cookies. Every
request's `Host` and `Origin` must be the server's own, which defeats DNS
rebinding, and no other site can reach it, preflights included. The checks are
listed in [`SECURITY_REVIEW.md`](SECURITY_REVIEW.md). Don't share the link
while `signet dev` runs.

What the UI defends against, and how each is checked in a real browser
(#587, `apps/sandbox-ui/e2e/security.spec.ts`, in CI on Linux):

| Threat                                                    | Defence                                                                          | Checked by                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| A web page you visit calls the UI (fetch, or a form POST) | Every request's `Origin` must be the server's own; no CORS headers are ever sent | A page on a second local origin, holding the real token: its fetch fails, its form POST is refused (403), nothing changes |
| DNS rebinding: a hostile name that resolves to 127.0.0.1  | The `Host` header must be the server's own                                       | A raw request with `Host: evil.example` is refused (403)                                                                  |
| Someone without the link                                  | A per-run token, sent as a header from the URL fragment; no cookie               | The page without the fragment says the link is needed; the API answers 401                                                |
| Another machine on the network                            | The server listens on 127.0.0.1 only                                             | Connecting on the machine's non-loopback address fails (skipped where there is none)                                      |

The tests run the UI's real server code, embedded app and API through
`cli/internal/devui/harness` over a stub session: `signet dev` itself needs a
contract crate, cargo, the stellar CLI and a live RPC, which a hermetic test
does not have.

The page is a view over the same session the terminal drives (#577), through
an API under `/api/` that is local to the server and versioned with the
binary: the session's provenance, the deployed and built specs and WASMs, a
call as `signet sandbox call` runs it, the latest cycles, the fork's entries
and the overrides, overrides added for the session, and a call saved to
`signet.dev.toml` as `--save` saves it. `/api/events` streams
`build.started`, `build.failed`, `cycle.completed` and `drift` as NDJSON. The
API is described in
[`sandbox/protocol/devui-openapi.yaml`](../sandbox/protocol/devui-openapi.yaml).

The UI's **Diagram** view (#580; `signet visualise --open` lands on it) draws
the build's interface with the web page's renderer, redrawn after every
cycle. A function or type the build added against the deployed interface
carries a `+`, a changed one a `~`, and removed ones are listed. With the UI
on, each saved call's A and B runs return their call trees (#541): the
build's trees fill in read/write marks, labelled as local sandbox runs and
never mixed with chain observations, and the selected call's A and B trees
are shown side by side, a frame that went differently marked. None of it
leaves the machine: the UI only talks to its own `/api/`.

### The reload cycle

Each build is compared with the deployed contract from the same state (#566).
At startup signet dev opens the fork in one simulator process, reads the
contract's instance and deployed WASM into it, and takes a checkpoint, `base`.
Every cycle then installs the new build (once per distinct WASM) and runs each
saved call twice, each time from `base`: as **A** on the deployed executable,
and as **B** with the new build swapped into the instance. Both sides of a
call run with the same PRNG seed, the seed of its position in the file, so a
contract that draws from `env.prng()` sees the same values on both.

Each cycle prints one summary line, then what needs a look (#637):

```text
✗ build 2.1s · install 3ms · swap 4ms · 2 saved replays 180ms · 1 breaking · 1 cost · 0 ignored
  interface: 2 breaking, 0 compatible, 0 info
    function-removed functions.upgrade
    argument-added functions.increment.inputs.caller
  breaking
    increment  return: Ok(1) → Err(Refused)
  cost
    get        resources: instructions -3.1% (282,900 → 274,014), mem_bytes -0.1% (1,128,283 → 1,127,294)
```

The summary counts replays by their worst difference, and starts with ✗
when a replay broke or missed its `expect`. Interface and storage layout
findings come first, then one line per replay with differences, grouped
(failed expectations, breaking, behavioural, cost), with the first difference
inline and how many more. A real transaction whose replay did not behave as
it did on-chain is listed apart, as `low-fidelity (not counted)`. A failed
build says which build is still active. `--verbose` prints every difference
of every replay (a storage table with before and after, the events, the auth
tree, the resource deltas) and the time by phase: install, swap, the A runs,
the B runs, and the diffs. On a terminal the marks are coloured and `--clear`
clears the screen before each cycle; piped, the output is plain and
append-only.

A depends only on the fork and the call, so it is run once and reused: a
cycle after the first runs B alone, unless a call changed (a chained call's A
is reused only with everything before it in the chain).

Each call's `expect` is then checked against B (#567): `unchanged` holds when
A and B differ in nothing the `[diff]` rules do not ignore, `ok` when B did not
fail, `error:<Name>` when B failed with that contract error, and `any` always.
The file's `[[override]]`s are applied once, before `base`; changing them in
`signet.dev.toml` starts the session over from a new `base`. The process stays
warm between saves, but the simulator's five-minute idle stop can still end it
while you are not saving; the next cycle respawns it, replays the fork, the
installs and `base`, and says `simulator restarted (idle)` rather than hiding
what that cost.

Each cycle also checks the build against what the contract stored (#571):
every entry of it the session knows, an instance's storage values included.
A stored map with symbol keys is matched to the old spec's struct with exactly
those field names, and a vec led by a symbol to the union with that case and
arity; the new spec's type of that name must then read it. A build whose
structs read through CAP-86's sparse unpack (soroban-sdk 28 builds do) takes a
missing `Option` field as `None` and ignores fields it no longer declares; a
strict build needs the stored fields to be exactly its own. That is the
`static` evidence. A call that ran on the deployed code and failed on the
build, with a host conversion error or the trap a sparse build hits when a
required field reads as nothing, is `replay` evidence against the keys the
deployed code read on it whose type changed.

```text
  storage layout: 1 stored value the build cannot read
    CDJP…3T2B instance "profile" (Profile, static): the new Profile does not decode the stored value: age: field missing from Profile
```

The gaps are real: a value that is not a map or a union (a `u32`, an
`Address`) matches no type and is counted as `unmatched_values`, not checked;
a lazy fork holds only the keys something read, so an archive fork (`signet
sandbox fork --archive`) is the way to check every stored entry; and a key no
replay reads yields no `replay` evidence.

Parsing modules is not cached between calls. Measured on the registry in a
release build (`module_parse_share`, an ignored test in
`sandbox/simulator/src/lanes/host_lane.rs`), building the VM is 65% of a
`count` simulate on p28 (1.76 of 2.69 ms) and 60% on p29. The way to skip it,
re-running a call through the enforcing host with its earlier footprint and a
module cache, would misreport two things the A/B comparison looks at: a
footprint that shrank (a read the new build dropped would still be listed),
and the cost, since a cached module is charged less than recording mode
charges the A side. Caching A instead halves every later cycle's host runs
without either.

### Diff classes

Every difference between the deployed run (A) and the build's (B) has a class
(#569), and the classes are what `--fail-on` and the terminal's grouping use:

| Class         | What it means                                    | Examples                                                                                            |
| ------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `breaking`    | a caller would see something else                | another return value or error, a storage write added, removed or changed, a signer added or removed |
| `behavioural` | the call does the same, observably otherwise     | an event added, removed or changed                                                                  |
| `cost`        | a resource moved beyond its `resource_tolerance` | instructions, memory, bytes read and written, the resource fee                                      |
| `ignored`     | left out by `[diff]`                             | an event or key matched by `ignore_events` or `ignore_storage`, auth with `ignore_auth`             |

What the checks cannot see: a replay shows only what its call touched, so a
code path no saved call or real transaction reaches is never compared; a
lazy fork knows only the keys something read, so the layout check covers
those (an archive fork covers every entry); and a real transaction runs on
today's state, so its diff is only as good as its fidelity.

### Performance

Fast feedback is the point of signet dev, and `cargo` build time is outside
it, so the targets cover everything else (#638), for a warm fork of a
registry-sized contract with 20 replays:

| Step                                                           | Target   | Laptop         | CI runner      |
| -------------------------------------------------------------- | -------- | -------------- | -------------- |
| swap: back to `base`, build swapped in                         | ≤ 20 ms  | 0.22 ms        | 0.04 ms        |
| A and B: 20 replays on each side, each from `base`             | ≤ 300 ms | 109 ms         | 13.5 ms        |
| diff of one call                                               | ≤ 20 ms  | 0.95 ms        | 0.08 ms        |
| cold start from a cached fork: spawn, handshake, `ledger_open` | ≤ 500 ms | 5.3 ms         | 0.73 ms        |
| one `claim`, without a trace / with one (#541)                 |          | 3.27 / 4.16 ms | 0.40 / 0.51 ms |

Measured with `cargo bench -p signet-simulator --bench cycle
--no-default-features --features lane-p28` (medians, through the real binary
over stdio, on the registry at p28): the laptop is an Intel Core i5-6300U with
4 threads and 16 GB, rustc 1.97.1; the CI runner is GitHub's `ubuntu-latest`
(the `sandbox benchmarks` job). The replays mix `count`, `resolve` and
`claim`. Capturing a trace adds about 27% to a call on both, which is why the reloader asks
for one only when the local UI's Diagram view needs it.

`signet dev --timings=json` writes the same breakdown for a real session to
stderr, one JSON object per line: `{"event":"start","spawn_ms":…,"open_ms":…}`
once, then per cycle `build_ms`, `install_ms`, `swap_ms`, `a_ms`, `b_ms`,
`diff_ms`, and how many replays and simulations ran.

The `sandbox benchmarks` CI job runs the benches and fails when a median is
more than 30% slower than `sandbox/simulator/benches/baseline.json`
(`node scripts/check-bench.mjs`), relative to a `calibration` benchmark of
fixed CPU work in the same run: shared runners differ in speed by more than
30% between runs, and the calibration moves with them. Rerun a failure once
before believing it; when a change is meant to be slower, the job's last step
prints the medians to commit as the new baseline.

### Real transactions

With `[replay] recent_transactions` set (signet dev init writes 20; a file
without it replays none), each session also replays the contract's latest
real transactions after the saved calls (#635, #636). They are found three
ways, each counted in the startup line:

- **events**: `getEvents` for the contract over the RPC's retention window,
  which finds every transaction that emitted an event;
- **scan** (`--scan-ledgers N`): `getTransactions` over the newest N ledgers,
  each decoded by the simulator, for the ones that emitted nothing. It is off
  by default, as it decodes every transaction in those ledgers;
- **indexer**: the hashes a Signet deployment indexed.

A transaction found more than once is replayed once, and the newest
`recent_transactions` are kept. Transactions are cached in the fork, so a
second session reads them without RPC.

```text
3 real transactions to replay (ledgers 4778014–4899013): found 3 by events; 1 no longer retrievable; 1 skipped
  3f2a…9c1d: not retrievable: outside the RPC's retention window (ledgers 4778014–4899013)
  ab07…5e22: called the contract through CROU…TER9, not directly
```

A hash RPC no longer has is listed, not dropped. Skipped are transactions
that failed on-chain (unless `include_failed`), that ran another host
function than `InvokeContract`, or that called the contract through another
one: only a direct call replays as itself.

A replay is labelled `tx 3f2a… (ledger 4851010, claim)` and links to the
transaction on stellar.expert. It sends the transaction's arguments exactly as
it did (as XDR, `args_xdr` in the protocol), from its source account, with
recording-mode auth, since its signatures' nonces are spent. It runs against
the fork's state, not the state at its ledger, so each one's A side is
checked against what the chain did: the same return value and the same
contract events, XDR against XDR. A replay that matches is high-fidelity; one
that does not is marked `low-fidelity (state changed since ledger N)` with
what differs, and its A/B diff says less about the change. A failed
transaction (`include_failed`) is high-fidelity when A fails too. A
low-fidelity replay's diff is shown but does not fail `--ci` unless
`fail_on_low_fidelity = true`.

## `signet.dev.toml`

Saved calls, replay settings, diff rules and storage overrides live in a
`signet.dev.toml` committed with the contract, so a teammate or CI runs the
same checks (#560). The CLI reads it strictly: a key the schema does not have
is an error naming its line, so a typo never silently turns a check off.

```toml
version = 1
network = "testnet"          # or a [network] table with rpc_url and passphrase
address = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"
path = "./contracts/registry"   # the crate directory; package = "identity-registry" in a workspace

[replay]
saved = true                 # replay the [[call]]s below
recent_transactions = 20     # and the contract's last 20 transactions; 0 disables
include_failed = false       # also replay transactions that failed on-chain
fail_on_low_fidelity = false # let a low-fidelity replay's diff fail --ci

[[call]]
name = "count is stable"
function = "count"
args = {}
expect = "unchanged"         # unchanged | ok | error:<Name> | any

[[call]]
name = "a taken handle is refused"
function = "claim"
args = { handle = "alice", wallet = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }
expect = "error:HandleTaken"

[[override]]
durability = "persistent"
key = 'Owner("alice")'
value = '"GC6YINA5FD5MLUI4LKC4JYI5AKAW7BRFJRKNEU3TVRZWYNYN3KKZJR3G"'

[diff]
ignore_events = []           # event topic prefixes: "transfer", "transfer/GABC…"
ignore_storage = []          # key patterns: 'Balance(*)', "count"
resource_tolerance = { instructions = "10%", fee = "500" }
```

- `version` is `1`, the only version there is.
- `network` names a network (`testnet`, `mainnet`), or is a table with
  `rpc_url` and `passphrase` for any other.
- `address` is the deployed contract (`C…`); `path` (and `package`) the crate
  it is built from.
- A `[[call]]` has a unique `name`, a `function`, its `args` as JSON-shaped
  TOML in the contract's argument encoding (the same as `--arg`), and what it
  should do: `unchanged` (the same result as the last time it ran), `ok`,
  `error:<Name>` (that contract error), or `any`. Against the deployed
  contract, each function must exist, its arguments must encode, and an
  expected error must be one the contract declares. Calls run in file order,
  each from the fork; `chain = true` starts a call from the previous call's end
  state instead, on both sides, so a pair like `claim` then `resolve` sees the
  claim.
- An `[[override]]` is a storage override, as `--set-storage` takes:
  `durability` (`instance`, `persistent` or `temporary`), `key`, and `value` or
  `unset = true`.
- `[diff]` says which differences between the deployed code and the build
  matter (#569). `ignore_events` are topic prefixes, topic texts separated by
  `/`; `ignore_storage` are key patterns in the `--set-storage` key syntax with
  `*` for any value (`Balance(*)`, `Allowance("G…", *)`, `count` for an
  instance key); `ignore_auth = true` leaves auth changes out, and `signet dev`
  warns that it does; `resource_tolerance` lets `instructions`, `mem_bytes`,
  `read_bytes`, `write_bytes`, `read_entries`, `write_entries` and `fee` move by
  a percentage of the deployed code's (`"10%"`) or an amount (`"500"`). Every
  difference is classed `breaking` (outcome, return value, storage, auth),
  `behavioural` (events), `cost` (a resource beyond its tolerance) or
  `ignored`; ignored ones are still listed and counted.

`signet dev init <contract> [--path ./contract]` writes a commented
`signet.dev.toml` in the current directory to start from, with one saved call
per read-only function: a function that takes no arguments and, run on a fork,
wrote nothing. It never guesses arguments for the others, and keeps an
existing file unless `--force`.

The quickest way to build the suite is to explore with `signet sandbox call`
and keep what is worth keeping: `--save` appends the call as a `[[call]]`
(named after its function, or `--save="a name"`), with its arguments as they
were parsed and `expect = "unchanged"`. It finds `signet.dev.toml` by walking
up from the working directory, writes nothing when there is none, and only
appends: what is already in the file, comments included, stays as it was.

Editors with [Taplo](https://taplo.tamasfe.dev) can validate the file against
[`sandbox/protocol/schema/v1/signet-dev-toml.json`](../sandbox/protocol/schema/v1/signet-dev-toml.json);
the CLI's tests hold this page's example to that schema.

## `signet dev --ci`

The checks that run on save also gate a pull request (#639). `--ci` builds
once, runs every replay, prints the cycle without colour, and exits with a
code a pipeline can branch on:

| Exit | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| 0    | clean                                                                     |
| 10   | a difference in a `--fail-on` class, or a replay that missed its `expect` |
| 12   | the build failed                                                          |
| 6, 7 | a network problem, a timeout                                              |
| 11   | the network runs a protocol this simulator has no lane for                |
| 13   | the simulator failed                                                      |

```bash
signet dev --ci --report report.json --junit junit.xml --fail-on breaking,spec,layout
```

- `--fail-on` takes `breaking`, `behavioural` and `cost` (a replay with a
  difference of that class fails), `spec` (a breaking interface change) and
  `layout` (a stored value the build cannot read). The default is
  `breaking,spec,layout`. A low-fidelity real replay fails only with
  `fail_on_low_fidelity = true`.
- `--report` writes JSON, schema
  [`ci-report.json`](../sandbox/protocol/schema/v1/ci-report.json): the build,
  each replay with its differences, verdict and fidelity, the interface and
  layout findings, which failed, and the exit code.
- `--junit` writes JUnit XML: one testcase per replay, per interface change
  and per layout finding, or one for the build when it failed. A failure's
  message is the first difference, as the terminal shows it.
- Without `--bundle` the run forks the live network, so real-transaction
  replays and the fetched state depend on it, and the report says so. With
  `--bundle repro.json` it runs offline on the bundle's state and calls
  (`signet sandbox export`, [Repro bundles](#repro-bundles)), with fetching
  denied.

### In a contract's own CI

[`docs/examples/signet-dev-ci.yml`](examples/signet-dev-ci.yml) is a
workflow to copy into a contract's repository: it installs Rust with
`wasm32v1-none`, `stellar` 25.2.0 and `@signet/cli` (which carries
`signet-simulator`), caches `~/.cache/signet` and `target`, runs
`signet dev --ci --bundle .signet/regression.json --junit junit.xml` and
publishes the JUnit report as a check.

There are two ways to run it:

- **Bundle-based (recommended).** Record the calls once from a session
  (`signet dev`, then `signet sandbox export -o .signet/regression.json`) and
  commit the bundle. Every run replays the same state and calls offline, so
  the check is deterministic: a failure is the change, not the network.
  Re-export when the deployment or the calls you care about change.
- **Live.** Drop `--bundle`: each run forks the deployed contract on the
  network and replays its saved calls and its latest real transactions. That
  catches traffic the bundle has never seen, but the result moves with the
  chain, an RPC outage fails the run (exit 6 or 7), and a real transaction
  whose state has moved on is only low-fidelity. Run it on a schedule, or as
  a non-required check, beside the bundle-based one.

This repository runs the example on itself (the `sandbox-e2e` CI job, #641):
signet and signet-simulator built from source, the registry built from
`packages/contracts/identity-registry`, `signet dev --ci` on
`sandbox/testdata/registry.bundle.json` with the RPC pointed at a closed
port, then again after a patch to `count`'s return, which must exit 10 with
`count` failing in the JUnit file.

## Repro bundles

Every `signet dev` session is logged (#572): a session record, each distinct
build, and every cycle's calls, overrides, results and footprint keys, as
NDJSON in `.signet/sessions/<timestamp>.ndjson` next to `signet.dev.toml`.
`signet dev init` adds `.signet/` to `.gitignore`.

`signet sandbox export -o repro.json` turns the newest session (or
`--session <file>`) into a repro bundle, one JSON file someone else can re-run
offline: the network and fork, every entry a footprint read in the session
(the minimum a re-run needs) and the network config, both WASMs with their
sha256, the last cycle's calls, overrides and results, and the simulator build
and lane. Its `bundleHash` is the sha256 of its canonical JSON (keys sorted, no
whitespace, without `bundleHash`), and exporting one session twice gives the
same file. A bundle over `--max-size` (25MB by default) is refused with the
parts that take the room. The format is
[`sandbox/protocol/schema/v1/bundle.json`](../sandbox/protocol/schema/v1/bundle.json).

`signet sandbox replay repro.json` re-runs a bundle with no network access
(#573): the host opens with fetching denied, loads the bundle's entries,
network config and overrides, and runs its calls on both WASMs as `signet dev`
did, with the same PRNG seeds. Every side must match the bundle's expected
outcome and return value, or it exits `10`; `--wasm fix.wasm` runs another
build against someone's repro. A bundle recorded on a lane this simulator does
not run exits `11`, and an edited one (its `bundleHash` no longer matches)
exits `2`. `--stream` writes every call's full results as NDJSON: CI replays
the committed bundles in `sandbox/fixtures/bundles/` on Linux x64 and arm64,
macOS arm64 and Windows x64 and checks the streams are byte-identical.

Fork data is public chain state, but overrides and saved-call arguments are
whatever you typed; export says so, and the bundle is worth reading before it
is shared.

## Localnet

`--localnet`, running against a local Stellar Quickstart network in Docker
instead of a fork, is planned (#588, #589, #590) and not in this build. A
fork covers the same ground for one contract, without Docker; a localnet will
add what a fork cannot, such as several contracts deployed together from
scratch. When it lands, this section will list what a fresh localnet is not
seeded with (accounts, assets and contracts that exist on testnet).

## Protocol support

A Soroban host only runs at its own ledger protocol, so `signet-simulator`
carries one host per protocol it supports, a **lane**: today protocols 28 and
29 (`sandbox/simulator/lanes.toml`). Before anything is forked, signet reads
the network's protocol and refuses to run on a host that does not match: a
wrong host would answer with plausible numbers, which is worse than no answer.
The refusal exits 11 and says which way the network moved:

- the network is ahead (`testnet is on protocol 30; this signet-simulator
supports 28–29. Upgrade @signet/cli (or build from main)`);
- the network is behind (`… supports 28–29, which is newer. Use an older
@signet/cli release that has a protocol 27 lane`);
- a contract built for a newer protocol than the lane is refused with both
  versions.

`signet sandbox doctor` shows the whole picture: the CLI's and simulator's
versions, the lanes and the host each links, the selected network's (and
testnet's) live protocol with a verdict, the `stellar`, `cargo` and Docker
versions, and the fork cache's size. It exits 11 when a checked network has no
lane; `--json` writes `sandbox/protocol/schema/v1/cli-sandbox-doctor.json`.

## Fidelity against the network

`signet sandbox fidelity <contract> --call count --call 'resolve={"handle":"aquawolf"}'`
runs each call through the local host, on a fork, and through the RPC's own
`simulateTransaction`, and compares (#575): the return value, the auth
entries (who signs for which invocation; nonces are each simulator's own),
the read-only and read-write footprint key sets (an auth nonce key aside),
and the resource fee within `--fee-tolerance` (10%). The local side is padded
as RPC pads (`adjustment: "rpc"`), so on the registry the fees for `count` and
`resolve` match to the stroop and a `claim` is within about 5%. Any difference
exits `10`; `--summary` appends a Markdown table.

The `Sandbox fidelity` workflow runs it nightly against the registry on
testnet (`count`, `resolve`, and `claim` of a fresh handle as a preview) and
can be dispatched by hand. Its `ledger_protocol` input runs the local side on
another lane; on these calls the p28 and p29 hosts agree exactly, so a lane
the network is not on does not show as a difference here, and a lane the
simulator lacks fails the run instead.

## Registry goldens

`sandbox/simulator/tests/golden/registry/` pins what the simulator makes of
Signet's own contract, built from `packages/contracts` (#574): initialized,
with two handles claimed as in the SDK tests, then `count`, `resolve`,
`lookup`, a claim of a taken handle, a `release` without the owner's signature
(enforced auth, no entries) and a `resolve_batch` over `MAX_BATCH_SIZE`, each
with its return value or error, events, storage writes and auth. Cost and fees
are left out, and the executable's hash inside written entries is zeroed, so
the goldens pin behaviour whatever rustc built the WASM. The claim event is
also checked against the SDK's own `claim_emits_event` snapshot.
`cargo test -p signet-simulator golden` runs them on `SIGNET_REGISTRY_WASM`,
or builds the contract with the stellar CLI (and skips without one);
`UPDATE_GOLDEN=1` rewrites them. CI runs them in the contracts job, on the
WASM it builds.

## Troubleshooting

### Exit codes

Every signet command exits with one of these, so a script can branch on the
code instead of the message:

| Code  | Meaning                                                                                                                                      | What to do                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `0`   | success, or a clean check                                                                                                                    |                                                                                          |
| `1`   | an unexpected error                                                                                                                          | report it, with the command and its output                                               |
| `2`   | invalid input: an argument, a flag, an edited bundle                                                                                         | read the message; it names the input                                                     |
| `3`   | configuration: the config file, a missing tool (`stellar`, `cargo`, the `wasm32v1-none` target), no contract crate, or no `signet-simulator` | install or fix what it names; `signet doctor` and `signet sandbox doctor` check them all |
| `4`   | no identity: `stellar` could not resolve the one asked for                                                                                   | `stellar keys ls`; pass `--source`                                                       |
| `5`   | signing failed                                                                                                                               |                                                                                          |
| `6`   | a network problem: the RPC or a deployment could not be reached, or an entry drifted with `--drift fail`                                     | check `--rpc-url`; refork                                                                |
| `7`   | timed out                                                                                                                                    | retry; a slow RPC may need another `--rpc-url`                                           |
| `8`   | an approval was rejected                                                                                                                     |                                                                                          |
| `9`   | the wallet is already linked elsewhere                                                                                                       |                                                                                          |
| `10`  | a difference: a `--fail-on` class in `signet dev --ci`, a replay that missed its `expect`, a bundle replay or a fidelity check that differs  | a finding, not a failure: read the report                                                |
| `11`  | the network runs a ledger protocol the simulator has no lane for, or a bundle was recorded on one                                            | upgrade `@signet/cli` (the message says which way)                                       |
| `12`  | the contract failed to build                                                                                                                 | the compiler's first error is shown                                                      |
| `13`  | the simulator itself failed, not a contract call inside it                                                                                   | see [a simulator crash](#a-simulator-crash)                                              |
| `14`  | the contract's WASM carries no interface spec                                                                                                | build it with `contractspecv0` (the SDK does by default)                                 |
| `130` | interrupted with Ctrl-C                                                                                                                      |                                                                                          |

### macOS: "cannot be opened because the developer cannot be verified"

Binaries downloaded from a GitHub Release are quarantined by Gatekeeper.
Remove the attribute from both, then run them as usual:

```bash
xattr -d com.apple.quarantine signet signet-simulator
```

The npm install is not affected.

### Windows: "Windows protected your PC"

SmartScreen stops an unrecognised download. Choose **More info**, then **Run
anyway**, or unblock both files in PowerShell:
`Unblock-File signet.exe, signet-simulator.exe`.

### A stale fork

A fork pins one ledger. When results stop matching what you see on-chain, or
signet warns about drift, take a fresh one: `signet sandbox forks refresh`
(or `signet sandbox forks rm`, then fork again). `--drift refork` does it
automatically when drift is found.

### A simulator crash

When the simulator exits or writes something that is not the protocol, the
command exits 13 and the error carries the last 50 lines the simulator wrote
to its stderr, under `simulator stderr (last lines):`. Those lines are what a
bug report needs.

### The two handshake failures

signet greets the simulator before anything else
([`CLI_RUST_BRIDGE.md`](CLI_RUST_BRIDGE.md#handshake-first-message-on-every-subprocess-session)),
and stops with one of two messages:

- `simulator protocol version mismatch: CLI expects N, found binary reporting
M`: `signet` and `signet-simulator` come from different releases. Reinstall
  so both come from the same one, and check `SIGNET_SIMULATOR_PATH` is not
  pointing at an old build.
- `could not start the contract simulator`: the binary found is not a
  simulator, or exited before answering. Reinstall; on macOS see the
  quarantine note above.
