# The Go ↔ Rust bridge (design note)

This is a design note, not implementation. **No Rust crate is scaffolded by
this document** — it exists so the boundary between the Go CLI
(`cli/cmd`, `cli/internal`) and the Rust contract simulator (`sandbox/simulator`)
is fixed _before_ code lands on either side of it, per
[#298](https://github.com/blockchain-maxis/signet/issues/298). §2 holds the
message catalogue; the machine-readable form of every message is in
[`sandbox/protocol/schema/v1/`](../sandbox/protocol/schema/v1).

## Why this can't wait

The CLI's planned contract sandbox — testing a deployed contract's functions
against real inputs and inspecting the outputs — needs `soroban-env-host` to
actually execute a call. `soroban-env-host` is Rust-only; there is no Go
binding. Go was chosen for the CLI specifically for its trivial
cross-compilation (`GOOS`/`GOARCH`, one `go build` per target, no toolchain
per platform) — a property cgo would forfeit outright, since a cgo build
needs a matching C/C++ toolchain and target sysroot for every platform it
cross-compiles to. `erst` draws this same boundary between a Go CLI and a
Rust simulator crate, bridged as a subprocess speaking JSON over stdio rather
than cgo, for the same reason. This note fixes that same shape for Signet,
before any Rust code exists to make deciding it under time pressure tempting.

## 1. Transport

**A long-lived subprocess, newline-delimited JSON (NDJSON) over stdin/stdout,
no cgo.**

- The Go CLI spawns the Rust binary once per sandbox session (not once per
  call) and keeps it alive across multiple simulate requests within that
  session. `soroban-env-host` initialization (loading a ledger snapshot,
  building the host environment) is the expensive part of a call; paying that
  cost once per session rather than once per call is the entire reason to keep
  the process warm instead of spawning a fresh one per request.
- Every message, either direction, is exactly one JSON object terminated by
  `\n`. No `Content-Length` framing (unlike LSP) — payloads here are
  simulation inputs/outputs, not large enough to need it, and NDJSON is
  trivial to line-buffer on both sides.
- `stderr` is reserved for the Rust process's own diagnostic/panic output,
  never protocol data. The Go side logs it verbatim on a non-zero exit but
  never parses it.
- Nothing crosses the boundary except JSON on stdio. No shared memory, no
  Unix sockets, no cgo — the whole point is that the Go binary never links
  against Rust code, so cross-compiling the Go binary stays exactly as cheap
  as it is today.

## 2. Message envelope and versioning

Every message in both directions carries the same envelope:

```jsonc
{
  "version": 1, // wire protocol version — bumped only on a breaking
  // change to this envelope or a message schema, never
  // on the CLI's own release version
  "id": "req-1", // caller-assigned, echoed back on the matching
  // response — correlates requests to responses and
  // leaves room for pipelining later without another
  // version bump
  "type": "...", // discriminant — see message types below
  // ...type-specific fields
}
```

`version` is an integer on _every_ message, not just at handshake — a stray
message from a differently-versioned process is rejected on sight rather than
only at startup.

### Handshake (first message on every subprocess session)

```jsonc
// Go -> Rust, first line written
{ "version": 1, "id": "hello", "type": "hello", "client_protocol_version": 1 }

// Rust -> Go, first line read
{
  "version": 1, "id": "hello", "type": "hello_ack",
  "server_protocol_version": 1,
  "simulator_version": "0.1.0",
  "commit": "7ad61d0dc5da",
  "lanes": [{ "ledger_protocol": 28, "env_host": "28.0.2", "simulation": "28.0.2" }]
}
```

`hello_ack` also says which build answered: `simulator_version`, the `commit` it
was built from, and `lanes`, one entry per ledger protocol the binary can run
(the `soroban-env-host` and `soroban-simulation` versions behind each). The
compatibility rule is unchanged: **the integer protocol versions must match
exactly.** The other three fields are for diagnostics and for choosing a lane
in `ledger_open`; Go never refuses a binary because of them.

Go compares `client_protocol_version` (its own, compiled in) against
`server_protocol_version` (whatever the spawned binary reports) before
sending a single simulate request. Three outcomes:

| Observed                                                                                                                           | Action                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Versions match                                                                                                                     | Proceed.                                                                                                                                                                                                                                                                                               |
| Versions differ                                                                                                                    | Refuse to simulate. Report: `"simulator protocol version mismatch: CLI expects N, found binary reporting M — reinstall signet-cli so both binaries come from the same release."` This is a distinct, actionable error — never a raw JSON decode failure surfaced to the user.                          |
| First line isn't valid `hello_ack` JSON (including: not JSON at all, wrong `type`, or nothing written before the subprocess exits) | Treat as "no usable simulator binary". Report: `"could not start the contract simulator — reinstall signet-cli."` This also covers a pre-handshake binary from before this protocol existed; see the release-matrix note in §5 on why that case is not expected to occur in a correctly-installed CLI. |

The handshake is defense-in-depth, not the primary compatibility mechanism —
§5's release packaging is what's supposed to make version drift impossible in
a normal install. The handshake is what turns "impossible in theory" into a
clear message instead of a hang or a cryptic decode error on the day it
happens anyway (a manually replaced binary, a stale `PATH` entry, a partial
upgrade).

### Request / response messages (the v1 catalogue)

Every message is a `type` value in the envelope above. A request from Go is
answered by one line with the same `id`: `type: "result"` on success, or one of
the failures in §3 (`contract_error`, `error`). The fields below are the
contract; [`sandbox/protocol/schema/v1/<type>.json`](../sandbox/protocol/schema/v1)
is the same thing as a JSON Schema, and each request schema also carries its
success response under `definitions.result`.

**Go never parses XDR.** It moves base64 blobs between the RPC and the
simulator and never decodes them, so the CLI does not depend on
`github.com/stellar/go`, and XDR version skew between ledger-protocol lanes stays
inside Rust. Anything Go needs to look inside (a spec, a value, a transaction,
a ledger key) is a message that returns JSON.

| `type`              | What it does                                                                   | Request fields                                                            | `result` fields                                                       |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ledger_open`       | Open or reset the in-memory ledger a session simulates against                 | `network_passphrase`; optional `ledger_protocol`, `sequence`, `timestamp` | `ledger_protocol`, `sequence`                                         |
| `ledger_put`        | Write entries into the open ledger                                             | `entries[]` of `{key_xdr, entry_xdr, live_until_ledger?}`                 | `written`                                                             |
| `ledger_get`        | Read entries by key                                                            | `keys_xdr[]`                                                              | `entries[]`, `entry_xdr: null` when absent                            |
| `ledger_checkpoint` | Snapshot the ledger                                                            | optional `label`                                                          | `checkpoint`                                                          |
| `ledger_rollback`   | Restore a checkpoint (it stays valid)                                          | `checkpoint`                                                              | none                                                                  |
| `ledger_import`     | Replace the ledger with a whole snapshot                                       | `ledger_sequence`, `entries[]`; optional `ledger_timestamp`               | `imported`, `ledger_sequence`                                         |
| `contract_install`  | Install an executable                                                          | `wasm_base64`; optional `contract_id`                                     | `contract_id`, `wasm_hash`                                            |
| `contract_swap`     | Point an installed contract at another executable, as an upgrade would         | `contract_id`, `wasm_hash`                                                | `contract_id`, `previous_wasm_hash`, `wasm_hash`                      |
| `simulate`          | Run a function ([#534](https://github.com/blockchain-maxis/signet/issues/534)) | `contract_id`, `function`, `args[]` (JSON); optional `source_account`     | `return_value_xdr`, `events[]`, `cost`, `logs[]`                      |
| `spec_extract`      | Read the spec out of an executable                                             | `source`: `{wasm_base64}` or `{contract_id}`                              | `spec_entries_xdr[]`, `wasm_hash`                                     |
| `spec_encode_args`  | Encode JSON arguments to ScVals from a spec                                    | `source`, `function`, `args[]`                                            | `args_xdr[]`                                                          |
| `spec_decode_val`   | Decode a ScVal to JSON as a function's return type                             | `source`, `function`, `val_xdr`                                           | `value`                                                               |
| `spec_diff`         | Compare the interfaces of two executables                                      | `old`, `new` (each a `source`)                                            | `compatible`, `changes[]`                                             |
| `layout_check`      | Check that stored-data layout survives an upgrade                              | `old`, `new`                                                              | `compatible`, `issues[]`                                              |
| `diff_results`      | Compare two `simulate` results field by field                                  | `left`, `right` (each a `simulate` result body)                           | `equal`, `differences[]`                                              |
| `xdr_keys`          | Derive the ledger key of each entry                                            | `entries_xdr[]`                                                           | `keys_xdr[]`                                                          |
| `tx_decode`         | Decode a transaction envelope                                                  | `transaction_xdr`                                                         | `transaction`                                                         |
| `wasm_inspect`      | Report what an executable declares, without running it                         | `wasm_base64`                                                             | `wasm_hash`, `size_bytes`, `interface_version`, `exports[]`           |
| `status`            | Report simulator state                                                         | none                                                                      | `uptime_ms`, `ledger_open`, `ledger_sequence`, `entries`, `contracts` |
| `shutdown`          | Answer, then exit 0                                                            | none                                                                      | none                                                                  |

`hello` / `hello_ack` are the handshake above. `ledger_fetch` and
`ledger_entries` are the one exchange that runs the other way, described next.

`simulate` takes **JSON arguments** and the simulator encodes them from the
contract's spec
([#545](https://github.com/blockchain-maxis/signet/issues/545)); this replaces
the earlier sketch of an `args_xdr` list built in Go. `spec_encode_args` and
`spec_decode_val` expose the same encoding on their own.

```jsonc
// Go -> Rust
{ "version": 1, "id": "req-7", "type": "simulate",
  "contract_id": "C...", "function": "transfer", "args": ["alice", "100"] }

// Rust -> Go, on a successful simulation (the call executed, whatever it returned)
{ "version": 1, "id": "req-7", "type": "result",
  "return_value_xdr": "AAAA...",
  "events": [{ "type": "contract", "event_xdr": "AAAA..." }],
  "cost": { "cpu_insns": 1234, "mem_bytes": 5678 },
  "logs": [] }
```

#### `ledger_fetch`: the simulator asking Go for state

While a `simulate` is in flight the simulator may need a ledger entry it does
not hold. It writes one request of its own, and Go answers it before the
`simulate` can finish:

```jsonc
// Rust -> Go, while req-7 is still running
{ "version": 1, "id": "sim-1", "type": "ledger_fetch", "keys_xdr": ["AAAA..."] }

// Go -> Rust
{ "version": 1, "id": "sim-1", "type": "ledger_entries",
  "entries": [{ "key_xdr": "AAAA...", "entry_xdr": "AAAA...", "live_until_ledger": 1000 }] }
```

It has its own `id` space: every simulator-originated id starts with `sim-`, so
it can never collide with an id Go assigned
([#531](https://github.com/blockchain-maxis/signet/issues/531)). An entry Go
could not find comes back with `entry_xdr: null`.

Why a request at all, and not a snapshot sent up front: `soroban-simulation`
reads state through a `SnapshotSource`, the RPC's `getLedgerEntries` only serves
the **latest** ledger, and `stellar snapshot create` took 3m27s and then failed
when tested for this epic. So the earlier sketch's per-request `ledger_snapshot`
cannot be the default way state reaches the simulator.

#### Errors

`contract_error` and `error` keep the split in §3. Both now carry more:

- **`contract_error.kind`** is `"contract"` (a `contracterror` the contract
  returned) or `"host"` (a trap, budget exhaustion or another host error).
  A `contract` error may also carry `decoded`: the error enum, case name, value
  and doc comment read from the contract's spec
  ([#546](https://github.com/blockchain-maxis/signet/issues/546)).
- **`error.code`** is one of the six below, and **`error.detail`** is always an
  object with a machine-readable `kind`. `id` is `null` only when the line could
  not be read far enough to find one.

| `code`                        | When                                                                                                                                                                | `detail.kind` values                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bad_request`                 | The line or the message is not valid                                                                                                                                | `line_too_long`, `invalid_utf8`, `invalid_json`, `not_an_object`, `invalid_field` (with `path`), `unknown_type`, `handshake_required`, `already_greeted` |
| `unsupported_version`         | `version` is not the protocol version this binary speaks                                                                                                            | `version_mismatch` (with `expected`, `received`)                                                                                                         |
| `internal_panic`              | The simulator panicked; the last line before a non-zero exit                                                                                                        | `panic`                                                                                                                                                  |
| `unsupported_ledger_protocol` | `ledger_open` asked for a lane this binary does not carry ([#533](https://github.com/blockchain-maxis/signet/issues/533))                                           | `ledger_protocol` (with `requested`, `supported`)                                                                                                        |
| `fetch_failed`                | Go could not answer a `ledger_fetch` ([#531](https://github.com/blockchain-maxis/signet/issues/531), [#535](https://github.com/blockchain-maxis/signet/issues/535)) | `rpc_unavailable`, `timeout`, `rejected`                                                                                                                 |
| `resource_limit`              | A request went over a limit the simulator enforces ([#536](https://github.com/blockchain-maxis/signet/issues/536))                                                  | `cpu_budget`, `memory_budget`, `ledger_entries`, `wasm_size`                                                                                             |

#### Maximum line length

A line may be at most **64 MiB** by default, because `contract_install` carries
a whole executable and `ledger_import` a whole snapshot. A longer line is
answered with `bad_request` / `line_too_long`, and the reader skips to the next
newline and carries on.

#### Who owns what

**Go owns retries, caching, timeouts and restarts. Rust owns XDR and execution.**
The simulator is single-threaded and has no in-band cancel, so Go enforces a
deadline by killing the process (§4) and then rebuilds the state from the fork
cache and the session log
([#526](https://github.com/blockchain-maxis/signet/issues/526)).

### Schemas and transcripts

- [`sandbox/protocol/schema/v1/*.json`](../sandbox/protocol/schema/v1): one JSON
  Schema (draft-07) per message type above plus `hello`, `hello_ack`,
  `contract_error`, `error`, `ledger_fetch` and `ledger_entries`. They are
  self-contained. Check that they compile with:

  ```bash
  npx ajv-cli compile -s 'sandbox/protocol/schema/v1/*.json'
  ```

- [`sandbox/protocol/transcripts/*.ndjson`](../sandbox/protocol/transcripts):
  golden transcripts, one message per line, in the order they cross the pipe:
  the handshake, a version mismatch, a simple `simulate`, a `ledger_fetch` round
  trip, a `contract_error` of each kind, and each `error` code. In them
  `<commit>` and `<version>` stand for the build identity baked into the binary.
- [`sandbox/protocol/check-transcripts.mjs`](../sandbox/protocol/check-transcripts.mjs)
  validates every transcript line against its schema (a `result` against the
  `definitions.result` of the request with the same `id`), and fails if a schema
  is not mentioned in this note. A request answered by an `error` with the same
  `id` is the malformed input that error is about, so it is exempt.

  ```bash
  node sandbox/protocol/check-transcripts.mjs
  ```

  The simulator's own integration test (`sandbox/simulator/tests/transcripts.rs`)
  replays the transcripts the binary already implements byte for byte.

## 3. Error contract

Two categories, kept explicitly distinct end to end — conflating them is
exactly what would make "the contract call I'm testing failed" and "the
sandbox itself is broken" indistinguishable to a user running the tool the
sandbox exists to support:

1. **Contract execution errors** — the simulated call itself trapped,
   reverted, or returned a host error. This is an _expected_, common outcome
   of exercising a function's inputs — the whole reason the sandbox exists —
   so it comes back as a well-formed `contract_error` response over the same
   successful request/response cycle, never as a subprocess failure. The CLI
   renders it directly: _"this call would fail: `<code>` — `<message>`"_.
2. **Protocol-level errors** — a malformed request, an unsupported protocol
   version, or an internal fault in the Rust process (a panic, a corrupted
   snapshot it can't open). These are bridge failures, not answers about the
   contract under test, and are surfaced as a distinct CLI error category
   (`simulator error`, never phrased as if the contract itself failed). They
   arrive as an `error` message when the process is still alive to send one,
   or are inferred by Go from a dead pipe / non-zero exit / a line that isn't
   valid JSON at all.

The Rust side wraps its top-level dispatch loop in `catch_unwind`: on a panic,
it makes a best-effort attempt to write a `type: "internal_panic"` `error`
message before exiting non-zero, so Go isn't left staring at a silently
closed pipe. This is best-effort only — a panic mid-write can still just kill
the process — so Go's dead-process handling (§4) is the real backstop, not
this line.

## 4. Timeout contract

- Every `simulate` request is bounded by a per-request timeout, default 10s,
  configurable (flag and env var) — ordinary simulation is fast; the timeout
  exists for a pathological or unbounded-recursion input, which is exactly
  the kind of thing a sandbox is for finding.
- On timeout, Go does not wait for a graceful response: it sends `SIGTERM`
  to the subprocess, waits a short grace period (2s), then `SIGKILL`s if it
  is still alive. The CLI reports a distinct `timeout` category — never
  folded into `simulator error` — with guidance that the call may be looping.
- A timeout invalidates only that subprocess instance, not the CLI session:
  the next `simulate` call transparently spawns and re-handshakes a fresh
  subprocess. The user does not need to restart the CLI.
- **Idle timeout.** If a live subprocess sees no request for 5 minutes (an
  interactive sandbox session left open), Go proactively terminates it to
  free the resident `soroban-env-host` state, and respawns on the next
  request. Same transparent-respawn path as the request-timeout case.

## 5. Binary location and the release matrix

- The Rust binary is a separate executable — `signet-simulator` (`.exe` on
  Windows) — never embedded inside the Go binary. Embedding a native binary
  via `go:embed` would bloat every Go build with every platform's simulator
  binary and reintroduce a cgo-shaped coupling in spirit even without cgo
  itself; shipping it as a sibling file keeps the two build pipelines (`go
build`, `cargo build`) fully independent.
- It is built for the same target matrix the Go binary already ships for —
  whatever that matrix is at the time. Today it is linux/amd64, linux/arm64,
  darwin/amd64, darwin/arm64 and windows/amd64 — not every OS × architecture
  pair; see `scripts/release/build-cli.sh` and `.github/workflows/release-cli.yml`
  — since a Rust target without a corresponding Go release target is
  never reachable and a Go release target without a matching Rust build would
  ship a CLI whose sandbox silently can't start on that platform.
- **Packaging.** Each per-platform release archive contains both binaries at
  the same directory level (`signet` / `signet.exe` and `signet-simulator` /
  `signet-simulator.exe`), built from the same commit/tag in one release job.
  This is what makes "same release = same protocol version" true by
  construction — the handshake in §2 is the runtime check for when that
  invariant is violated after the fact (a manually replaced binary, a partial
  upgrade, a stale copy earlier on `PATH`), not the mechanism that is
  supposed to keep them in sync day to day.
- **Location resolution**, in order, first match wins:
  1. `$SIGNET_SIMULATOR_PATH`, if set — explicit override, for development
     and non-standard installs (e.g. running a locally built simulator
     against a released CLI, or vice versa).
  2. Next to the running Go executable
     (`filepath.Dir(os.Executable())/signet-simulator[.exe]`) — the normal
     case for an installed release, since the two ship in the same archive.
  3. `$PATH` — a fallback for installs that unpack the archive into a
     directory already on `PATH` without preserving the sibling layout (e.g.
     some package-manager formulas).
  4. None found → the sandbox command fails immediately with an actionable
     "contract simulator not found — reinstall signet-cli or set
     `SIGNET_SIMULATOR_PATH`", not a spawn error surfaced from the OS.

## What this note deliberately does not do

- It does not make a message real by listing it. §2 fixes the fields of every
  v1 message so both sides build against one spec, but a message exists in
  the simulator only once its own issue lands (`hello` and `shutdown` today).
  A message the binary does not know yet is answered with `bad_request` /
  `unknown_type`, which is part of the contract, not a bug.
- It does not scaffold `cmd/`, `internal/`, or a `simulator/` crate. Per the
  issue this fixes the boundary _before_ code exists on either side of it —
  writing code here would be deciding implementation details this note is
  explicitly trying to settle first.
