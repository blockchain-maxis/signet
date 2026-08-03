# identity-registry

Soroban contract that binds a Stellar wallet to a Signet handle on-chain.

> **Status:** implemented. 13 unit tests, builds to a ~11 KB wasm.

## Trust model

To claim a handle the wallet owner must authorize the `claim` invocation.
Soroban enforces a valid signature from that wallet's key
(`wallet.require_auth()`), so a binding can only be created by the key holder —
no trusted oracle, no off-chain admin minting identities. Bindings are 1:1
(one handle per wallet, one wallet per handle).

## Interface

| Method | Auth | Description |
|--------|------|-------------|
| `initialize(admin)` | — | One-time; sets the moderation admin. |
| `claim(handle, wallet)` | `wallet` | Bind `handle` ↔ `wallet`. Emits `claimed`. |
| `release(handle)` | owning wallet | Remove your binding. Emits `released`. |
| `transfer_handle(handle, new_wallet)` | current owner | Move a handle to another wallet. Emits `transferred`. |
| `admin_revoke(handle)` | `admin` | Moderation force-remove. Emits `released`. |
| `resolve(handle) -> Option<Address>` | — | Handle → wallet. |
| `lookup(wallet) -> Option<String>` | — | Wallet → handle. |
| `is_bound(handle) -> bool` | — | Whether a handle is taken. |
| `count() -> u32` | — | Number of bound handles (O(1)). |

Full enumeration of handles is intentionally **off-chain**: reconstruct the set
from the `claimed` / `released` event stream (what the indexer does). The
contract stores only an O(1) counter, so storage and per-call cost stay constant
no matter how many handles exist.

Handles are `[a-z0-9_-]`, 1–32 chars. Errors are returned as a `contracterror`
(`HandleTaken`, `WalletAlreadyBound`, `InvalidHandle`, `NotOwner`, …).

To call the deployed contract from your own app — contract id, numeric error codes,
event layout and `@stellar/stellar-sdk` snippets — see
[`docs/REGISTRY_INTEGRATION.md`](../../../docs/REGISTRY_INTEGRATION.md).

## Build & test

```bash
# From repo root
cargo test --manifest-path packages/contracts/identity-registry/Cargo.toml

cargo build \
  --manifest-path packages/contracts/identity-registry/Cargo.toml \
  --target wasm32v1-none --release
```

## Deploy (testnet)

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/identity_registry.wasm \
  --network testnet --source <KEY>
# then invoke initialize(admin) and set NEXT_PUBLIC_IDENTITY_REGISTRY_ID in the web app.
```
