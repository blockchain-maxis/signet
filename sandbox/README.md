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

| Path         | What                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `simulator/` | The `signet-simulator` binary                                        |
| `protocol/`  | Golden NDJSON transcripts replayed by `simulator/tests/transcripts.rs` |
| `fuzz/`      | Fuzz target stub; excluded from default members, so plain `cargo` skips it |

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
signet-simulator 0.1.0 (commit 9b0764e496ad) protocol 1 lanes 28
```

The commit comes from an override variable read by `simulator/build.rs` if
set, then from git, and is `unknown` when neither is available (for example a
build from a source tarball).

## Pins

- `sandbox/rust-toolchain.toml` pins the toolchain; `rustup` installs it on
  first use.
- `soroban-env-host` and `soroban-simulation` are pinned to `=28.0.2`. Bump
  them together, deliberately, and update the lanes number in
  `simulator/src/main.rs` when the protocol moves.
- `sandbox/Cargo.lock` is committed and CI builds with `--locked`.
