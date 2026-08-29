# @signet/contracts — Soroban smart contracts

Rust/Soroban smart contracts for Signet, managed as a Cargo workspace
(separate from the pnpm/TypeScript workspace).

## Crates

- [`identity-registry`](./identity-registry) — binds a Stellar wallet to a
  Signet identity via signed, on-chain claims. Implemented; unit tests over
  known cases plus property tests (see [Testing](#testing)).

## Prerequisites

- Rust (stable) — https://rustup.rs
- `wasm32v1-none` target:

  ```bash
  rustup target add wasm32v1-none
  ```

- (Optional) Soroban CLI for deployment:

  ```bash
  cargo install --locked soroban-cli
  ```

## Build

```bash
# Native build + tests
cargo test --manifest-path packages/contracts/Cargo.toml

# Wasm build (deployment artifact)
cargo build \
  --manifest-path packages/contracts/identity-registry/Cargo.toml \
  --target wasm32v1-none --release
```

## Testing

Two layers, both in the `contracts` CI job's `cargo test` run:

- **Unit tests** (`identity-registry/src/test.rs`) — known cases: each
  entrypoint's happy path, each error, and the auth requirements. Each one also
  writes a committed snapshot under `identity-registry/test_snapshots/`, so a
  change in observable behaviour (an SDK or protocol upgrade included) shows up
  as a reviewable diff.
- **Property tests** (`identity-registry/src/property_test.rs`) — the *rules*
  those cases are examples of, checked by `proptest` against generated input:
  handle validation against an independent oracle over arbitrary byte strings,
  `resolve_batch` either side of `MAX_BATCH_SIZE`, and the invariant that
  `count` equals the number of live bindings after any sequence of
  claim / release / transfer / revoke. These run with snapshot capture off —
  a file per generated case would be hundreds of them, differing every run.

`proptest` is a dev-dependency, so none of this reaches the deployment wasm.

When a property fails, proptest shrinks the input to a minimal counter-example
and records its seed in `identity-registry/proptest-regressions/`. Commit that
file: it turns the failure into a permanent regression case.

## Size budget

The release wasm is the on-chain deployment artifact, so its size is a cost and
a footprint concern. CI enforces a budget in the `contracts` job (see
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)): the build fails if
`identity_registry.wasm` exceeds **20 KB** (`BUDGET_BYTES=20480`).

`identity-registry` is ~9 KB today, so the budget leaves headroom for planned
growth while catching accidental bloat — a heavy dependency, or a release
profile that lost `opt-level = "z"` / `lto` / `strip`. Raise `BUDGET_BYTES`
deliberately when a size increase is expected and justified.
