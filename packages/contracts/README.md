# @signet/contracts — Soroban smart contracts

Rust/Soroban smart contracts for Signet, managed as a Cargo workspace
(separate from the pnpm/TypeScript workspace).

## Crates

- [`identity-registry`](./identity-registry) — binds a Stellar wallet to a
  Signet identity via on-chain attestations. Currently a Soroban
  "Hello World" stub.

## Prerequisites

- Rust (stable) — https://rustup.rs
- `wasm32-unknown-unknown` target:

  ```bash
  rustup target add wasm32-unknown-unknown
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
  --target wasm32-unknown-unknown --release
```
