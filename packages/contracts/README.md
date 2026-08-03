# @signet/contracts — Soroban smart contracts

Rust/Soroban smart contracts for Signet, managed as a Cargo workspace
(separate from the pnpm/TypeScript workspace).

## Crates

- [`identity-registry`](./identity-registry) — binds a Stellar wallet to a
  Signet identity via signed, on-chain claims. Implemented; 13 tests.

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

## Size budget

The release wasm is the on-chain deployment artifact, so its size is a cost and
a footprint concern. CI enforces a budget in the `contracts` job (see
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)): the build fails if
`identity_registry.wasm` exceeds **20 KB** (`BUDGET_BYTES=20480`).

`identity-registry` is ~9 KB today, so the budget leaves headroom for planned
growth while catching accidental bloat — a heavy dependency, or a release
profile that lost `opt-level = "z"` / `lto` / `strip`. Raise `BUDGET_BYTES`
deliberately when a size increase is expected and justified.
