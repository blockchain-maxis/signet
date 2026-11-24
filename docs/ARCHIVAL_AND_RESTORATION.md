# Storage Archival & Restoration Runbook

This runbook documents the lifecycle of Soroban persistent storage entries in Signet's Identity Registry, why handle bindings archive after ~30 days of inactivity, how the web app handles archived bindings, and how operators/users restore them.

---

## 1. Soroban Persistent Storage Lifecycle

Soroban smart contracts on Stellar manage ledger state through **Time-To-Live (TTL)** counters:

- **TTL Window**: The contract configures `BUMP_LEDGERS = 518_400` (~30 days at ~5s per ledger) with a `BUMP_THRESHOLD = 86_400` (~5 days).
- **Active / Hot Storage**: Whenever an entry is read or written, the contract invokes `extend_ttl` on the key it touched, resetting its TTL to ~30 days. `resolve` bumps only `DataKey::Owner(handle)`; `lookup` bumps only `DataKey::Handle(wallet)`; `claim` and `transfer_handle` bump both. Every **invoked** entry point, reads included, also bumps the contract instance (`Admin`/`Count`), which archives on its own TTL. A _simulated_ read extends nothing: its footprint is discarded (see `docs/DEPLOYMENT.md` §11).
- **Cold / Archived Storage**: If a binding is not touched by an _invoked_ call for ~30 days, its storage entries expire and move into Soroban's **archived cold storage**.

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

Operators can restore archived entries with the `stellar` CLI; this restores the
registry's instance entry (an archived instance fails every call):

```bash
# Restore the registry's instance entry (Admin/Count).
stellar contract restore \
  --id "$REGISTRY_CONTRACT_ID" \
  --source <KEY_OR_IDENTITY> \
  --rpc-url "$SOROBAN_RPC_URL" \
  --network-passphrase "<network passphrase>"
```

`--id` must be the Identity Registry, never another contract such as the
native XLM SAC — restoring a token contract's footprint does nothing for the
registry. The explicit `--rpc-url`/`--network-passphrase` pair also avoids the
CLI 25.2.0 `--network testnet` alias bug (see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §1).
Restoring the instance does not resurrect archived _bindings_: each archived
`DataKey::Owner(handle)` / `DataKey::Handle(wallet)` needs its own restore, and
DEPLOYMENT.md §11 covers the instance in more detail.

---

## 4. Keep-Alive Maintenance Tool

Entries are only extended by an **invoked** call: a simulated read extends
nothing, so `resolve`/`lookup` view calls cannot keep anything alive
(DEPLOYMENT.md §11). `scripts/keepalive-contract.mjs` therefore submits a real
`ExtendFootprintTTL` operation. It builds the footprint from the instance key
and, for each handle, `DataKey::Owner(handle)` plus — once the owner is
resolved — `DataKey::Handle(wallet)`, simulates it for resources, signs with
`KEEPALIVE_SECRET`, submits, and waits for the result.

Those keys must be the contract's own `DataKey` encoding: a `#[contracttype]`
enum keys a tuple variant by **name**, so the entry is
`vec[Symbol("Owner"), String(handle)]` (and
`vec[Symbol("Handle"), Address(wallet)]`), not a `U32` variant index. A key
built from an index matches nothing in storage, so the sweep would report
success while extending only the instance. Entries are reported as extended
only when their key is in the **submitted** footprint; a handle whose entry was
not found (unbound, or archived) is never counted.

```bash
# Report mode (no KEEPALIVE_SECRET): prints each entry's remaining ledgers and
# any unbound handle or archived entry. Submits nothing, needs no key.
node scripts/keepalive-contract.mjs --instance-only
node scripts/keepalive-contract.mjs alice bob

# Extend the instance and the bindings (~30 days). Needs a funded S... key
# that pays the fee.
KEEPALIVE_SECRET=S... node scripts/keepalive-contract.mjs alice bob
```

`REGISTRY_CONTRACT_ID` (or `NEXT_PUBLIC_IDENTITY_REGISTRY_ID`) is required;
there is no default id. Run it monthly — the entries expire after ~30 days.
To keep every bound handle alive, take the list from a deployment's directory
(`/handles`, or tRPC `profile.list`) and pass it in.
To sweep every bound handle, take the list from a deployment's directory (`/handles`,
or `GET /api/v1/profiles`) and pass it in.

The script exits non-zero when an entry is archived — restore it first (§3) —
or when a submission fails. To extend only the instance, `stellar contract
extend --id "$REGISTRY_CONTRACT_ID" --ledgers-to-extend 518400` (DEPLOYMENT.md
§11) does the same without the handle list.
