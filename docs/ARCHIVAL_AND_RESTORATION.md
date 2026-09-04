# Storage Archival & Restoration Runbook

This runbook documents the lifecycle of Soroban persistent storage entries in Signet's Identity Registry, why handle bindings archive after ~30 days of inactivity, how the web app handles archived bindings, and how operators/users restore them.

---

## 1. Soroban Persistent Storage Lifecycle

Soroban smart contracts on Stellar manage ledger state through **Time-To-Live (TTL)** counters:

- **TTL Window**: The contract configures `BUMP_LEDGERS = 518_400` (~30 days at ~5s per ledger) with a `BUMP_THRESHOLD = 86_400` (~5 days).
- **Active / Hot Storage**: Whenever an entry is read or written (`resolve`, `lookup`, `claim`, `transfer_handle`), the contract invokes `extend_ttl` on the persistent storage keys (`DataKey::Owner(handle)` and `DataKey::Handle(wallet)`), resetting their TTL to ~30 days.
- **Cold / Archived Storage**: If a handle's binding is neither read nor modified for ~30 days, its storage entries expire and move into Soroban's **archived cold storage**.

```text
[Claim / Read Access] ──▶ TTL = 30 days (Hot Persistent Storage)
                              │
                    No access for ~30 days
                              │
                              ▼
                   [Archived Cold Storage]
                              │
                    RestoreFootprint Tx
                              │
                              ▼
                 [Restored to Hot Storage]
```

---

## 2. Archival Impact & Resolution Behavior

### The Problem

When an entry is in cold archived storage:

- A standard simulation of `resolve(handle)` returns a `restorePreamble` containing the footprint rather than an immediate return value.
- Without proper handling, reading the profile would fail or return `null`, causing `/p/{handle}` to 404 even though the handle is legitimate and recorded on-chain.

### Signet's Handling

- **Detection**: `simulateReadDetailed` and `resolveHandleDetailed` in `apps/web/lib/server/registry-read.ts` detect `restorePreamble` in simulation responses.
- **Graceful Rendering**: `safeChainProfile` in `apps/web/lib/profiles.ts` marks the profile with `archived: true` and informs visitors that the binding is in cold storage rather than returning a 404 error.
- **User Restoration**: The web app provides client-side helper `restoreHandleBinding(handle, walletAddress)` in `apps/web/lib/registry.ts` which executes a `RestoreFootprint` transaction signed by the wallet.

---

## 3. How to Restore an Archived Handle Binding

### Method A: Client / Wallet via Web App

Call `restoreHandleBinding(handle, walletAddress)` from `lib/registry.ts`:

1. Simulates `resolve(handle)` to extract the storage footprint and fee requirements.
2. Builds an `Operation.restoreFootprint({})` transaction.
3. Requests wallet signature and submits the transaction to the Stellar network.

### Method B: Stellar CLI

Operators can restore any archived contract data entry using the `stellar` CLI:

```bash
# Restore footprint for the contract storage keys
stellar contract restore \
  --id CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
  --source <KEY_OR_IDENTITY> \
  --network testnet
```

---

## 4. Keep-Alive Maintenance Tool

To prevent active handles from lapsing into archived storage, run the keep-alive sweep script periodically (e.g. via a scheduled cron job or CI):

```bash
# Sweep all default demo handles
node scripts/keepalive-contract.mjs

# Sweep specific handles
node scripts/keepalive-contract.mjs aquawolf sorobuilder stellardev
```

The script simulates a `resolve` view call on each handle, which triggers the contract's internal `extend_ttl` to bump the TTL back to ~30 days without incurring transaction submission fees.
