# sandbox

Native Rust workspace for `signet-simulator`, the contract simulator the
`signet` CLI drives as a subprocess. It is a separate executable, never linked
into the CLI. The design is in [`docs/CLI_RUST_BRIDGE.md`](../docs/CLI_RUST_BRIDGE.md)
(see section 5 for how it is located and released).

This is not `packages/contracts`. That workspace builds Soroban contracts for
`wasm32v1-none` and optimises for size; this one builds a native binary
optimised for speed, with `panic = "unwind"` so a request can be caught without
killing the process.

## Layout

| Path         | What                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simulator/` | The `signet-simulator` binary                                                                                                                                     |
| `protocol/`  | JSON Schemas (`schema/v1/`) and golden NDJSON transcripts for every message in `docs/CLI_RUST_BRIDGE.md`; `check-transcripts.mjs` validates one against the other |
| `fuzz/`      | Fuzz target stub; excluded from default members, so plain `cargo` skips it                                                                                        |

## Message loop

With no arguments the binary reads NDJSON from stdin and writes NDJSON to
stdout (docs/CLI_RUST_BRIDGE.md §1-§3):

- `simulator/src/framing.rs` reads lines up to 64 MiB. A longer line gets a
  `bad_request` error (`detail.kind: "line_too_long"`) and the reader resumes
  at the next newline.
- `simulator/src/dispatch.rs` parses the envelope, echoes `id`, and checks
  `version` on every message (`unsupported_version` on a mismatch). The first
  message must be `hello`, answered with `hello_ack`; `shutdown` answers and
  exits 0. Anything else is a `bad_request` with the reason in `detail`.
- The loop runs inside `catch_unwind`. On a panic it makes a best-effort write
  of an `internal_panic` error and exits 101 without handling further input.
- Stdout is written only through one serialised writer. Logs go to stderr via
  `tracing`; set `SIGNET_SIMULATOR_LOG` (for example `debug`) to change the
  level (default `warn`).

```bash
echo '{"version":1,"id":"hello","type":"hello","client_protocol_version":1}'   | sandbox/target/release/signet-simulator
```

## Build and test

Run from the repo root (or `cd sandbox` and drop `--manifest-path`):

```bash
cargo build --release --locked --manifest-path sandbox/Cargo.toml
# -> sandbox/target/release/signet-simulator

cargo test --locked --manifest-path sandbox/Cargo.toml
cargo clippy --locked --manifest-path sandbox/Cargo.toml -- -D warnings
cargo fmt --all --check --manifest-path sandbox/Cargo.toml
```

Or use the root Makefile, which skips with a one-line notice when `cargo` is
missing: `make sandbox-build`, `make sandbox-test`, `make sandbox-lint`,
`make check-fmt-sandbox` (also folded into `make build`/`test`/`lint`/`check-fmt`).

The first build compiles `soroban-env-host` and takes several minutes.

## Version output

```text
$ sandbox/target/release/signet-simulator --version
signet-simulator 0.1.0 (commit 9b0764e496ad) protocol 1 lanes 28,29
```

The commit comes from an override variable read by `simulator/build.rs` if
set, then from git, and is `unknown` when neither is available (for example a
build from a source tarball).

## Pins

- `sandbox/rust-toolchain.toml` pins the toolchain; `rustup` installs it on
  first use.
- One host per ledger protocol: `soroban-env-host` and `soroban-simulation`
  are pinned per lane, as renamed dependencies (`soroban-env-host-p28` /
  `-p29`, both `=N.0.2`), the way stellar-core links one host per protocol.
  A production host only runs at its own protocol, so the binary carries the
  current protocol (29, both public networks since October 2026) and the
  previous one (28). Bump a lane's pins together, deliberately.

## Lanes

Each lane is a feature, both on by default: `lane-p28`, `lane-p29`. A
contributor can build one lane for speed:

```sh
cargo test --no-default-features --features lane-p29
```

Size, linux x64 release, stripped (#593): both lanes 10,437,224 bytes; protocol
28 alone 6,808,440. A lane costs about 3.6 MB. CI's `signet-simulator size
budget` job fails above 13,046,530 bytes (the first measurement plus 25%).

`simulator/src/lanes/p28/mod.rs` and `p29/mod.rs` alias their own pinned host
and `include!` the shared `lanes/host_lane.rs` (and `lanes/spec_impl.rs`), so
every lane runs the same code and the same tests; `tests/simulate.rs` runs its
suite once per lane.

`simulator/lanes.toml` is the single source of truth for the lanes (#591): each
lane's protocol and the `soroban-env-host` and `soroban-simulation` releases it
links. `build.rs` refuses to build when the pins in `Cargo.toml` disagree with
it (`tests/lanes_manifest.rs` covers the check), and the weekly protocol check
(#592) compares live networks against its newest lane.

### Adding a protocol lane

When a network announces protocol N:

1. Add `soroban-env-host-pN` and `soroban-simulation-pN` pins to
   `sandbox/Cargo.toml` (and `soroban-ledger-snapshot-pN` if the snapshot
   reader moves with it), and a `lane-pN` feature to `simulator/Cargo.toml`,
   on by default.
2. Add the `[[lane]]` to `simulator/lanes.toml` with the same versions.
3. Add `simulator/src/lanes/pN/mod.rs` and its entry in `lanes/mod.rs`'s
   `BUILTIN`.
4. Drop the oldest lane once no supported network runs it: its pins, feature,
   module, `BUILTIN` entry and `lanes.toml` entry together.
5. Regenerate the goldens and transcripts the new host changes
   (`UPDATE_GOLDEN=1 cargo test`, `sandbox/protocol/transcripts`), and the
   registry goldens (`docs/SANDBOX.md`, "Registry goldens").
6. Update the protocol numbers in this file and in `docs/SANDBOX.md`,
   "Protocol support", and check the size budget.

- `sandbox/Cargo.lock` is committed and CI builds with `--locked`.
