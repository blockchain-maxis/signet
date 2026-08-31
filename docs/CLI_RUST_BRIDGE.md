# The Go ↔ Rust bridge (design note)

This is a design note, not implementation. **No Rust crate is scaffolded by
this document** — it exists so the boundary between the future Go CLI
(`cmd/`, `internal/`) and the Rust contract simulator is fixed *before* code
lands on either side of it, per [#298](https://github.com/blockchain-maxis/signet/issues/298).

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
  "version": 1,        // wire protocol version — bumped only on a breaking
                        // change to this envelope or a message schema, never
                        // on the CLI's own release version
  "id": "req-1",        // caller-assigned, echoed back on the matching
                        // response — correlates requests to responses and
                        // leaves room for pipelining later without another
                        // version bump
  "type": "...",        // discriminant — see message types below
  // ...type-specific fields
}
```

`version` is an integer on *every* message, not just at handshake — a stray
message from a differently-versioned process is rejected on sight rather than
only at startup.

### Handshake (first message on every subprocess session)

```jsonc
// Go -> Rust, first line written
{ "version": 1, "id": "hello", "type": "hello", "client_protocol_version": 1 }

// Rust -> Go, first line read
{ "version": 1, "id": "hello", "type": "hello_ack", "server_protocol_version": 1 }
```

Go compares `client_protocol_version` (its own, compiled in) against
`server_protocol_version` (whatever the spawned binary reports) before
sending a single simulate request. Three outcomes:

| Observed | Action |
| --- | --- |
| Versions match | Proceed. |
| Versions differ | Refuse to simulate. Report: `"simulator protocol version mismatch: CLI expects N, found binary reporting M — reinstall signet-cli so both binaries come from the same release."` This is a distinct, actionable error — never a raw JSON decode failure surfaced to the user. |
| First line isn't valid `hello_ack` JSON (including: not JSON at all, wrong `type`, or nothing written before the subprocess exits) | Treat as "no usable simulator binary". Report: `"could not start the contract simulator — reinstall signet-cli."` This also covers a pre-handshake binary from before this protocol existed; see the release-matrix note in §5 on why that case is not expected to occur in a correctly-installed CLI. |

The handshake is defense-in-depth, not the primary compatibility mechanism —
§5's release packaging is what's supposed to make version drift impossible in
a normal install. The handshake is what turns "impossible in theory" into a
clear message instead of a hang or a cryptic decode error on the day it
happens anyway (a manually replaced binary, a stale `PATH` entry, a partial
upgrade).

### Request / response messages

```jsonc
// Go -> Rust
{
  "version": 1, "id": "req-7", "type": "simulate",
  "contract_id": "C...",
  "function": "transfer",
  "args_xdr": ["AAAA...", "AAAA..."],
  "network_passphrase": "Test SDF Network ; September 2015",
  "ledger_snapshot": "..."          // opaque snapshot handle/path — format owned by the Rust side
}

// Rust -> Go, on a successful simulation (the call executed, whatever it returned)
{
  "version": 1, "id": "req-7", "type": "result",
  "return_value_xdr": "AAAA...",
  "events": [ /* ... */ ],
  "cost": { "cpu_insns": 1234, "mem_bytes": 5678 },
  "logs": [ "..." ]
}

// Rust -> Go, on a contract-level failure (see error contract below)
{
  "version": 1, "id": "req-7", "type": "contract_error",
  "code": "HostError::...", "message": "...",
  "diagnostic_events": [ /* ... */ ]
}

// Rust -> Go, on a protocol-level failure
{
  "version": 1, "id": "req-7", "type": "error",
  "code": "bad_request" | "unsupported_version" | "internal_panic",
  "message": "..."
}
```

## 3. Error contract

Two categories, kept explicitly distinct end to end — conflating them is
exactly what would make "the contract call I'm testing failed" and "the
sandbox itself is broken" indistinguishable to a user running the tool the
sandbox exists to support:

1. **Contract execution errors** — the simulated call itself trapped,
   reverted, or returned a host error. This is an *expected*, common outcome
   of exercising a function's inputs — the whole reason the sandbox exists —
   so it comes back as a well-formed `contract_error` response over the same
   successful request/response cycle, never as a subprocess failure. The CLI
   renders it directly: *"this call would fail: `<code>` — `<message>`"*.
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
  whatever that matrix is at the time (linux/darwin/windows × amd64/arm64,
  today), since a Rust target without a corresponding Go release target is
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

- It does not define the `simulate` request/response fields exhaustively —
  §2's schema is illustrative of the *shape* (envelope, versioning,
  correlation id), not a final contract. The exact fields land with the
  sandbox work itself, once there is a concrete host-environment API to
  reflect.
- It does not scaffold `cmd/`, `internal/`, or a `simulator/` crate. Per the
  issue this fixes the boundary *before* code exists on either side of it —
  writing code here would be deciding implementation details this note is
  explicitly trying to settle first.
