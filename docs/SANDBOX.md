# The contract sandbox

`signet sandbox` runs a deployed contract's functions locally, against a fork
of the network, without submitting anything. The commands are in
[`cli/README.md`](../cli/README.md#signet-sandbox-fork); the design is in
[`CONTRACT_SANDBOX_DESIGN.md`](CONTRACT_SANDBOX_DESIGN.md), and the CLI ↔
simulator protocol in [`CLI_RUST_BRIDGE.md`](CLI_RUST_BRIDGE.md).

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
include_failed = false

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

| Threat | Defence | Checked by |
| --- | --- | --- |
| A web page you visit calls the UI (fetch, or a form POST) | Every request's `Origin` must be the server's own; no CORS headers are ever sent | A page on a second local origin, holding the real token: its fetch fails, its form POST is refused (403), nothing changes |
| DNS rebinding: a hostile name that resolves to 127.0.0.1 | The `Host` header must be the server's own | A raw request with `Host: evil.example` is refused (403) |
| Someone without the link | A per-run token, sent as a header from the URL fragment; no cookie | The page without the fragment says the link is needed; the API answers 401 |
| Another machine on the network | The server listens on 127.0.0.1 only | Connecting on the machine's non-loopback address fails (skipped where there is none) |

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

```text
replayed 2 saved calls on 936996c7 (deployed) and 4f1a09bd (build): 4 runs
  count is stable  A 2  =  B 2  ✓ unchanged
  claim taken  A error HandleTaken  =  B error HandleTaken  ✓ error:HandleTaken
```

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

## Archive forks

A lazy fork knows only the keys something has read and can mix ledgers.
`signet sandbox fork <C…> --archive` instead imports every entry of the
contract at a history-archive checkpoint through `stellar snapshot create`
(#554). It is slow: when this was planned, `stellar snapshot create` on testnet
ran for 3 minutes 27 seconds before a bucket download failed. A failed snapshot
is retried once; after that the lazy fork, which needs no archive, is the way
on.
