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
| `fuzz/`      | Fuzz target stub; excluded from default members, so plain `cargo` skips it |

Only `--version` exists so far. The message protocol arrives with #524.

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
