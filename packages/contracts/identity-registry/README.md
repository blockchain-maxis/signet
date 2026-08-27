# identity-registry

Soroban contract that binds a Stellar wallet to a Signet handle on-chain.

> **Status:** implemented. 30 unit tests, builds to a ~11 KB wasm.
>
> The source here is **ahead of the deployed testnet instance**; see
> [`docs/REGISTRY_INTEGRATION.md`](../../../docs/REGISTRY_INTEGRATION.md) §2 for
> exactly which methods the pinned wasm exposes.

## Trust model

To claim a handle the wallet owner must authorize the `claim` invocation.
Soroban enforces a valid signature from that wallet's key
(`wallet.require_auth()`), so a binding can only be created by the key holder —
no trusted oracle, no off-chain admin minting identities. Bindings are 1:1
(one handle per wallet, one wallet per handle).

The admin's only power is `admin_revoke`: force-removing a binding for
moderation. It cannot create or redirect one, so a compromised admin can censor
but never impersonate.

`initialize` requires the admin's own authorization. Deploying and initializing
are separate transactions, and without that requirement anyone could land their
own `initialize` in between and hold the moderation key permanently.

**Immutability is deliberate.** There is no upgrade entrypoint: the wasm backing
a binding cannot be swapped out from under the wallet that signed for it, which
is most of what makes the binding worth trusting. `set_admin` is the one
exception, and it is deliberately narrow — rotating the moderation key is
recoverable operations work, whereas replacing the code is not something a
holder consented to. Fixing a contract bug therefore means deploying a new
registry and migrating; budget for that rather than assuming a patch path.

## Interface

| Method | Auth | Description |
|--------|------|-------------|
| `initialize(admin)` | `admin` | One-time; sets the moderation admin. |
| `set_admin(new_admin)` | current `admin` | Rotate moderation authority. Emits `admin_changed`. |
| `claim(handle, wallet)` | `wallet` | Bind `handle` ↔ `wallet`. Emits `claimed`. |
| `release(handle)` | owning wallet | Remove your binding. Emits `released`. |
| `transfer_handle(handle, new_wallet)` | current owner | Move a handle to another wallet. Emits `transferred`. |
| `admin_revoke(handle)` | `admin` | Moderation force-remove. Emits `revoked`. |
| `resolve(handle) -> Option<Address>` | — | Handle → wallet. |
| `lookup(wallet) -> Option<String>` | — | Wallet → handle. |
| `is_bound(handle) -> bool` | — | Whether a handle is taken. |
| `count() -> u32` | — | Number of bound handles (O(1)). |
| `resolve_batch(handles) -> Vec<Option<Address>>` | — | Positional multi-resolve, max 100. |

## Storage lifetime

Bindings live in `persistent` storage and are bumped on every access; the admin
and the counter live in `instance` storage, which every write path bumps too.
Both matter: if the instance were allowed to archive while bindings stayed
alive, `initialize`-gated calls would start failing and the registry would look
bricked with its data intact.

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
