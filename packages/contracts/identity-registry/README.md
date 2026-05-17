# identity-registry

Soroban contract that binds a Stellar wallet to a Signet identity.

> **Status:** stub. Currently the standard Soroban "Hello World" contract so
> the workspace compiles. See the `TODO(signet)` in
> [`src/lib.rs`](./src/lib.rs).

## Planned responsibilities

- Record wallet → handle attestations on-chain.
- Verify the wallet owner's signature over the binding payload.
- Expose read methods the indexer uses to resolve `wallet -> identity`.

## Build & test

```bash
# From repo root
cargo test --manifest-path packages/contracts/identity-registry/Cargo.toml

cargo build \
  --manifest-path packages/contracts/identity-registry/Cargo.toml \
  --target wasm32-unknown-unknown --release
```
