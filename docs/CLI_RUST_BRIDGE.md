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
  "lanes": [
    { "ledger_protocol": 28, "env_host": "28.0.2", "simulation": "28.0.2" },
    { "ledger_protocol": 29, "env_host": "29.0.2", "simulation": "29.0.2" }
  ]
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

Inside Rust the same rule holds one level down ([#533](https://github.com/blockchain-maxis/signet/issues/533)):
the ledger store and the dispatcher keep XDR as bytes, and only
`sandbox/simulator/src/lanes/` names `soroban-env-host`, `soroban-simulation`
or `stellar-xdr`. Each `Lane` (today `lanes/p28` and `lanes/p29`, one pinned
host each, sharing one source) decodes with its own XDR crate, and
`LaneRegistry::for_protocol` picks the lane for a ledger, so another protocol is
a new lane module rather than a change to the store or the verbs
([#538](https://github.com/blockchain-maxis/signet/issues/538)). A
unit test fails the build if a versioned type leaks outside `lanes/`.

| `type`              | What it does                                                                                                                                                                                                                 | Request fields                                                                                                                                                                                                                                                                          | `result` fields                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger_open`       | Open or reset the in-memory ledger a session simulates against, and load its network config                                                                                                                                  | `network_passphrase`; optional `ledger_protocol`, `sequence`, `timestamp`, `base_reserve`, `fetch` (`allow` or `deny`), `entries[]` to seed                                                                                                                                             | `ledger_protocol`, `sequence`, `network_config`                                                                                                                                                                                                 |
| `ledger_put`        | Write entries into the open ledger                                                                                                                                                                                           | `entries[]` of `{key_xdr, entry_xdr, live_until_ledger?}`, or RPC's pieces `{key_xdr, data_xdr, last_modified_ledger_seq, ext_xdr?}`                                                                                                                                                    | `written`                                                                                                                                                                                                                                       |
| `ledger_get`        | Read entries by key                                                                                                                                                                                                          | `keys_xdr[]`                                                                                                                                                                                                                                                                            | `entries[]`, `entry_xdr: null` when absent                                                                                                                                                                                                      |
| `ledger_checkpoint` | Snapshot the ledger                                                                                                                                                                                                          | optional `label`                                                                                                                                                                                                                                                                        | `checkpoint`                                                                                                                                                                                                                                    |
| `ledger_rollback`   | Restore a checkpoint (it stays valid)                                                                                                                                                                                        | `checkpoint`                                                                                                                                                                                                                                                                            | none                                                                                                                                                                                                                                            |
| `ledger_import`     | Replace the ledger with a whole snapshot                                                                                                                                                                                     | `ledger_sequence`, `entries[]`; optional `ledger_timestamp`                                                                                                                                                                                                                             | `imported`, `ledger_sequence`                                                                                                                                                                                                                   |
| `ledger_apply`      | Write entries into the session layer, as a call does, to restore a saved session ([#555](https://github.com/blockchain-maxis/signet/issues/555))                                                                             | `entries[]` of `{key_xdr, entry_xdr \| null, live_until_ledger?}`                                                                                                                                                                                                                       | `applied`                                                                                                                                                                                                                                       |
| `contract_install`  | Install an executable (refused if it targets a newer protocol than the lane)                                                                                                                                                 | `wasm_base64`; optional `contract_id`                                                                                                                                                                                                                                                   | `contract_id`, `wasm_hash`                                                                                                                                                                                                                      |
| `contract_swap`     | Point an installed contract at another executable, as an upgrade would: storage and TTL kept, no constructor ([#539](https://github.com/blockchain-maxis/signet/issues/539))                                                 | `contract_id`, `wasm_hash`; optional `layer` (`session` default, or `override`); `mode` (`instance` or `ref`) for a CAP-85 instance                                                                                                                                                     | `contract_id`, `previous_wasm_hash`, `wasm_hash`, `mode`, `layer`                                                                                                                                                                               |
| `contract_info`     | Read a contract without running it, fetching its instance and code ([#550](https://github.com/blockchain-maxis/signet/issues/550))                                                                                           | `contract_id`                                                                                                                                                                                                                                                                           | `executable`, `wasm_hash`, `external_ref`, `storage_entries`, `instance_live_until`, `wasm_size`, `misses[]`                                                                                                                                    |
| `simulate`          | Run a function ([#534](https://github.com/blockchain-maxis/signet/issues/534))                                                                                                                                               | `contract_id`, `function`, `args` (JSON, by name or in order); optional `source_account`, `diagnostics`, `dry_run`, `budget`, `auth_mode`, `auth_entries[]`, `trace`, `ledger` (`sequence`, `timestamp`: this call only, [#558](https://github.com/blockchain-maxis/signet/issues/558)) | `return_value_xdr`, `return_value`, `events[]`, `cost`, `logs[]`, `diagnostic_events[]`, `auth[]`, `modified_entries[]`, `resources`, `fee`, `misses[]`, `ledger`, `archived[]` (entries read past their TTL: `restored` or `expired`), `trace` |
| `spec_extract`      | Read the spec out of an executable                                                                                                                                                                                           | `source`: `{wasm_base64}` or `{contract_id}`                                                                                                                                                                                                                                            | `spec_entries_xdr[]`, `wasm_hash`, `spec` (the SpecJson v1 document `@signet/spec` produces)                                                                                                                                                    |
| `spec_encode_args`  | Encode JSON arguments to ScVals from a spec                                                                                                                                                                                  | `source`, `function`, `args` (an object by name, or an array in order)                                                                                                                                                                                                                  | `args_xdr[]`                                                                                                                                                                                                                                    |
| `spec_decode_val`   | Decode XDR to JSON with the spec: a return value, a value of a named type, or a contract event                                                                                                                               | `source`; `val_xdr` with `function` or `as_type`, or `event_xdr`                                                                                                                                                                                                                        | `value`; a failed `Result` is `{error: {code, name, enum, doc, candidates?}}`                                                                                                                                                                   |
| `spec_diff`         | Compare the interfaces of two executables                                                                                                                                                                                    | `old`, `new` (each a `source`)                                                                                                                                                                                                                                                          | `compatible`, `changes[]`                                                                                                                                                                                                                       |
| `layout_check`      | Check that stored-data layout survives an upgrade                                                                                                                                                                            | `old`, `new`                                                                                                                                                                                                                                                                            | `compatible`, `issues[]`                                                                                                                                                                                                                        |
| `diff_results`      | Compare a call on the deployed code (`a`) with the same call on a new build (`b`) ([#568](https://github.com/blockchain-maxis/signet/issues/568))                                                                            | `a`, `b`: each `outcome` (`ok`/`error`), `error`, `return_value_xdr`, `events[]`, `storage[]` (written entries), `auth[]`, `resources`; optional `ledger_protocol`                                                                                                                      | `empty`, `outcome`, `return_value`, `events`, `storage`, `auth`, `resources[]`                                                                                                                                                                  |
| `xdr_keys`          | Build the ledger keys Go asks RPC for: a contract instance, a code entry, an account, a config setting, or every setting `NetworkConfig` loads                                                                               | `keys[]` of `{kind, ...}`; optional `ledger_protocol`                                                                                                                                                                                                                                   | `keys[]` of `{kind, subject, key_xdr}`                                                                                                                                                                                                          |
| `tx_decode`         | Decode a transaction envelope, and optionally its result meta, to JSON                                                                                                                                                       | `transaction_xdr`; optional `result_meta_xdr`, `ledger_protocol`                                                                                                                                                                                                                        | `transaction`                                                                                                                                                                                                                                   |
| `wasm_inspect`      | Report what an executable declares, without running it                                                                                                                                                                       | `wasm_base64`; optional `ledger_protocol`                                                                                                                                                                                                                                               | `wasm_hash`, `size_bytes`, `custom_sections[]`, `interface_version`, `exports[]`, `imports[]`, `upgradeable`                                                                                                                                    |
| `snapshot_read`     | Read a `stellar snapshot create` file ([#554](https://github.com/blockchain-maxis/signet/issues/554)): the ledger it was taken at and every entry, in the RPC form a fork cache holds; stateless, needs the protocol 28 lane | `snapshot_json` (the file's text)                                                                                                                                                                                                                                                       | `protocol_version`, `sequence_number`, `timestamp`, `network_id`, `base_reserve`, TTL minimums, `entries[]`                                                                                                                                     |
| `entries_describe`  | Ledger entries in plain terms, for `signet sandbox state` ([#554](https://github.com/blockchain-maxis/signet/issues/554))                                                                                                    | `entries[]` in the RPC form; optional `ledger_protocol`                                                                                                                                                                                                                                 | `entries[]`: an instance with its storage map, contract data with durability, key and value, code by hash                                                                                                                                       |
| `storage_override`  | Set or remove one storage entry of a contract in the override layer ([#559](https://github.com/blockchain-maxis/signet/issues/559))                                                                                          | `contract_id`, `durability` (`instance`, `persistent`, `temporary`), `key`, `value` or `unset: true`; optional `live_until`                                                                                                                                                             | `key_xdr`, `key` in words, `removed`, `live_until_ledger`                                                                                                                                                                                       |
| `status`            | Report simulator state                                                                                                                                                                                                       | none                                                                                                                                                                                                                                                                                    | `uptime_ms`, `ledger_open`, `ledger_sequence`, `entries`, `contracts`, `network_config`, `base_reserve`                                                                                                                                         |
| `shutdown`          | Answer, then exit 0                                                                                                                                                                                                          | none                                                                                                                                                                                                                                                                                    | none                                                                                                                                                                                                                                            |

The three XDR helpers ([#532](https://github.com/blockchain-maxis/signet/issues/532)) are how Go gets by without parsing XDR. None needs an open ledger; each decodes with the lane named by `ledger_protocol`, else the open ledger's, else the newest.

- `xdr_keys` builds the base64 `LedgerKey`s for RPC `getLedgerEntries`. `network_config` expands to exactly the `ConfigSetting` entries the lane's `NetworkConfig::load_from_snapshot` reads, so a fork ([#535](https://github.com/blockchain-maxis/signet/issues/535)) fetches no more and no less.
- `tx_decode` takes RPC `getTransaction`'s `envelopeXdr` and, optionally, `resultMetaXdr`. It returns the source account, the host function, and the auth entries; with the meta, also the on-chain return value and contract events, for [#636](https://github.com/blockchain-maxis/signet/issues/636)'s fidelity check (meta v3 and v4 alike). Only an `invoke_contract` host function is `replayable`; anything else says why not. Values come in a tagged display form (`{"type": "string", "value": "alice"}`) alongside their XDR, which Go passes on to `spec_decode_val` when it needs the contract's own types.
- `wasm_inspect` reports the WASM hash, the custom sections, the `contractenvmetav0` interface version, and the imported host functions ([#540](https://github.com/blockchain-maxis/signet/issues/540)), and `upgradeable`: `wasm` when it imports `update_current_contract_wasm` (`l`.`6`), `executable-ref` when it imports `update_current_contract_executable_ref` (`l`.`j`, protocol 28+), else `none`. The scan sees only the contract's own imports: one upgraded from outside, through a proxy or factory, reports `none`.

`hello` / `hello_ack` are the handshake above. `ledger_fetch` and
`ledger_entries` are the one exchange that runs the other way, described next.

`simulate` runs through `soroban-simulation`'s
`simulate_invoke_host_function_op`, the function RPC's `simulateTransaction`
runs, with no adjustments: `resources` and `fee.resource_fee` are raw, where RPC
pads them by default and wallets add a margin on top. A call that executed and
failed is a `contract_error` (with `decoded` naming the error from the spec);
one that succeeded has its writes applied to the session layer, unless
`dry_run` is set. Recording-mode auth draws nonces from a per-call PRNG seed
derived from the session's call count, so calls never collide and a replayed
session is identical. Fees, limits and TTLs come from the network's own `ConfigSetting` entries,
never from defaults ([#535](https://github.com/blockchain-maxis/signet/issues/535)).
`ledger_open` loads them when it opens: from `entries` it was given, or, on a
fork, fetched from Go with the keys `xdr_keys` `network_config` names. If any
is missing the open fails with `fetch_failed` / `missing_config`, `detail.missing`
listing each setting, and no ledger stays open. The effective configuration is
in `ledger_open`'s result and in `status`, for the "ran against" panel.
`LedgerInfo` comes from the open: the lane's protocol, `sequence`, `timestamp`,
the network id from the passphrase, and `base_reserve` (default 0.5 XLM).

**The A/B diff ([#568](https://github.com/blockchain-maxis/signet/issues/568)).**
`diff_results` compares what one call did on the deployed code and on a new
build. The values are compared in the lane as XDR, not as decoded JSON, so a
`u32` 1 and an `i128` 1 differ. A value difference is reported at the JSON
pointer of the first place the two values part (into vecs by index, maps by
key), with each side's tagged value there. Events are compared by index (the
same emitter and topics with another payload is `changed`), storage by the
written key (`added`, `removed`, `changed`, and a TTL change on its own; an
instance by its storage map, since B's executable is the build by
construction), and auth by signer, where any difference is `client_breaking`.
When the outcome differs only that and the resources are reported. Resources
are each metric both sides give that moved, absolute and as a percentage of A.

**Determinism ([#537](https://github.com/blockchain-maxis/signet/issues/537)).**
The same session on the same ledger state produces byte-identical results on
every run. A call's PRNG seed is `sha256(session_id ‖ call index)` (`session_id`
from `ledger_open`, the index as a big-endian u64), never random, and is
reported as `seed`; it drives both `env.prng()` and recording-mode auth nonces.
A `simulate` with `call_index` uses that index's seed and does not advance the
count, so one call run twice (signet dev's deployed and new code,
[#566](https://github.com/blockchain-maxis/signet/issues/566)) draws the same
seed both times. Execution reads no clock: the ledger time is `ledger_open`'s `timestamp`.
`modified_entries` and `misses` are ordered by their XDR bytes, and object keys
are sorted. What is not covered: the state itself (a fork fetches the network's
latest entries, so two forks of a moving network can differ; a repro bundle,
[#572](https://github.com/blockchain-maxis/signet/issues/572), pins them), and
host metering across CPU architectures, which the host computes from its own
cost model rather than measuring but which only
[#573](https://github.com/blockchain-maxis/signet/issues/573)'s cross-platform
check verifies. `status`'s `uptime_ms` is wall-clock and not part of any result.

**Auth ([#557](https://github.com/blockchain-maxis/signet/issues/557)).**
`simulate`'s `auth_mode` is `record` (the default: every `require_auth` is
approved and recorded, at any depth, signatures unchecked), `strict` (recording,
but auth required below the root invocation is refused, as the network does
without an entry for it), or `enforce` (the pre-signed `auth_entries` are
checked). Results report the mode and list the recorded auth as `auth_entries`
(credentials, address, root function).

**Traces ([#541](https://github.com/blockchain-maxis/signet/issues/541)).**
`simulate` with `trace: true` (or `{max_frames: N}`, default 10,000) returns
`trace`, the call tree the host ran, in the shape of
[`trace.json`](../sandbox/protocol/schema/v1/trace.json): each frame's contract,
function, parent and depth, the executable it ran, its arguments and result
(or error) as XDR; the footprint by contract (read-only, read-write, changed);
the ledger; and `seeded`, set when the run saw state the network does not have
(an installed or session-written entry, or a moved ledger). The tree is read from
the host's `fn_call` / `fn_return` diagnostic events, so asking for it turns
diagnostics on for that call (they are returned only if `diagnostics` was asked
for too). Recording-mode simulation builds its host internally and accepts no
`TraceHook`, so there are no per-frame instruction counts; the call's total is
`cost`. The host folds several arguments into one vec, so a nested call's
arguments are read by the callee's spec, and `args_exact` is false where no spec
could say. More frames than the cap set `truncated`, never silently.

`simulate` takes **JSON arguments** and the simulator encodes them from the
contract's spec
([#545](https://github.com/blockchain-maxis/signet/issues/545)); this replaces
the earlier sketch of an `args_xdr` list built in Go. `spec_encode_args` and
`spec_decode_val` expose the same encoding on their own.

The JSON shape is `@signet/spec`'s `functionArgsSchema` (the shape
`@stellar/stellar-sdk`'s `contract.Spec#jsonSchema` describes), so the terminal,
the local UI and saved calls share one encoding: `u32`/`i32` are numbers; 64-bit
and wider integers, `timepoint` and `duration` are decimal strings; bytes are
base64; addresses are strkeys; maps are arrays of `[key, value]` pairs; structs
are objects; unions are `{"tag": case, "values": [...]}`; enums are numbers. An
`Option` argument may be left out. A value that does not fit is a `bad_request`
/ `invalid_field` whose `detail.path` is `args.<path>` and whose message names
it, for example `wallet: expected Address (G… or C…), got number`.

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

Go answers with what RPC's `getLedgerEntries` gave it: `xdr` is
`LedgerEntryData`, not a whole `LedgerEntry`, so an entry may come as
`{key_xdr, data_xdr, last_modified_ledger_seq, ext_xdr?, live_until_ledger?}`
and the simulator assembles the `LedgerEntry` itself. Go never builds XDR.
`ledger_put` and `ledger_import` accept the same form.

The simulator files every answer in the fork layer, and a key Go does not
have in a negative cache, so a session never fetches one key twice. A
`simulate` result lists the keys that call fetched as `misses`. With
`ledger_open`'s `fetch: "deny"` (offline runs, bundle replay) a miss fails the
request with `fetch_failed` / `denied`, and `detail.key` names the key in
words.

A `simulate` result (and a `contract_error`) also lists, as `contracts`, the
other contracts the call reached by reading their instance, in order, each
with its `executable` and, for a Stellar Asset Contract, its `asset`
(`native` or `CODE:ISSUER`) ([#552](https://github.com/blockchain-maxis/signet/issues/552)).
With `related: false` the call is kept to its own contract: reading another
contract's instance fails it with `fetch_failed` / `related`, and
`detail.contract_id` names the contract it reached.

When Go cannot answer at all (the RPC is down, the fetch timed out, or this
session has no ledger source), it replies to the same `sim-` id with an `error`
whose `code` is `fetch_failed` and whose `detail.kind` is `rpc_unavailable`,
`timeout` or `rejected`. The simulator then fails the in-flight request with
that `fetch_failed` error. Go's client (`cli/internal/simulator`) runs the fetch
handler while it keeps waiting on the request, so the request's own timeout
still bounds a slow RPC.

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
| `unsupported_ledger_protocol` | `ledger_open` asked for a lane this binary does not carry ([#533](https://github.com/blockchain-maxis/signet/issues/533))                                           | `ledger_protocol` (with `requested`, `networkProtocol` (same value), `supported`)                                                                        |
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

- `trace` (`trace.json`) is not a message either: it is the call tree a
  `simulate` result carries when asked
  ([#541](https://github.com/blockchain-maxis/signet/issues/541)), a document of
  its own that the visualiser's sandbox adapter pins by its `version`.
- `signet-dev-toml` (`signet-dev-toml.json`) is not a message either: it is the
  schema of `signet.dev.toml`
  ([#560](https://github.com/blockchain-maxis/signet/issues/560),
  [`SANDBOX.md`](SANDBOX.md#signetdevtoml)), kept here for editors.
- `cli-call-result` (`cli-call-result.json`) is not a wire message: it is the object `signet sandbox call --json`
  writes ([#555](https://github.com/blockchain-maxis/signet/issues/555)), kept beside the
  messages it is built from.
- [`sandbox/protocol/transcripts/*.ndjson`](../sandbox/protocol/transcripts):
  golden transcripts, one message per line, in the order they cross the pipe:
  the handshake, a version mismatch, a simple `simulate`, a `ledger_fetch` round
  trip, a `contract_error` of each kind, each `error` code, and a traced
  caller → callee call on the fixture contracts. In them
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
- **What the simulator guards itself
  ([#536](https://github.com/blockchain-maxis/signet/issues/536)).** It adds no
  watchdog of its own: the wall clock is Go's. It keeps the default `SIGTERM`
  disposition, so it exits at once on `SIGTERM`, even mid-call. A single host
  call is bounded by its budget: the network's CPU and memory limits, or a
  `simulate` `budget` override of at most 10× them (reported in the result).
  Running out is a `contract_error` with `kind: "host"`, as on the network. A
  counting allocator caps the whole process at 2 GiB
  (`SIGNET_SIMULATOR_MEMORY_LIMIT` bytes): past it the simulator writes an
  `error` with `id: null`, code `resource_limit`, `detail.kind: "memory"`, and
  stops, and the next request respawns it.
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
