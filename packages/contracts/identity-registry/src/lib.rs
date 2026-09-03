#![no_std]
//! Signet Identity Registry
//!
//! On-chain, self-sovereign binding of a Stellar wallet to a Signet handle.
//!
//! The trust model is simple and verifiable: to claim a handle, the wallet
//! owner must authorize the `claim` invocation. Soroban enforces that the
//! transaction carries a valid signature from that wallet's keypair
//! (`wallet.require_auth()`), so a binding can only ever be created by someone
//! holding the wallet's private key. No off-chain curation, no trusted oracle.
//!
//! Bindings are 1:1 in this phase — one handle per wallet, one wallet per
//! handle. A handle is released by its owning wallet (auth required) or
//! revoked by the registry admin for moderation. Every state change emits an
//! event the Signet indexer consumes to resolve identities.
//!
//! There is no upgradeability: the deployed wasm is immutable, so nobody —
//! maintainers included — can rewrite the rule above after the fact. The price
//! is that a defect cannot be patched in place; it is recovered by deploying a
//! new contract and migrating bindings to it, which users complete by signing
//! one `claim` on the new registry. That procedure is written down in
//! `docs/CONTRACT_MIGRATION.md` rather than improvised during an incident.
//!
//! Enumeration of all handles is intentionally **off-chain**: the indexer
//! reconstructs the set from the `claimed`/`released` event stream. The
//! contract keeps only an O(1) `count` rather than an on-chain list, so storage
//! and per-call cost stay constant regardless of how many handles exist.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Vec,
};

/// Maximum handle length in bytes. Handles are short, URL-safe identifiers.
const MAX_HANDLE_LEN: u32 = 32;
/// Maximum number of handles in a single batch resolve call.
const MAX_BATCH_SIZE: u32 = 100;
/// Bump persistent entries by ~30 days (at ~5s ledgers) on access.
const BUMP_LEDGERS: u32 = 518_400;
/// Threshold below which an accessed entry gets bumped.
const BUMP_THRESHOLD: u32 = 86_400;

/// Handles that collide with the web app's top-level routes (see `apps/web/app`)
/// and must never be claimable, or a profile would shadow an app page. All are
/// lowercase, matching the `[a-z0-9_-]` charset enforced by `validate_handle`.
const RESERVED_HANDLES: [&str; 10] = [
    "p",
    "api",
    "app",
    "admin",
    "docs",
    "handles",
    "how-it-works",
    "profile",
    "robots",
    "sitemap",
];

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Registry admin (moderation authority).
    Admin,
    /// handle -> owning wallet `Address`.
    Owner(String),
    /// wallet `Address` -> handle.
    Handle(Address),
    /// The binding counter (O(1); enumeration is via events). An upper
    /// bound, not a live total - see [`IdentityRegistry::count`].
    Count,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    HandleTaken = 3,
    HandleNotFound = 4,
    NotOwner = 5,
    InvalidHandle = 6,
    WalletAlreadyBound = 7,
    HandleReserved = 8,
    BatchTooLarge = 9,
}

#[contract]
pub struct IdentityRegistry;

#[contractimpl]
impl IdentityRegistry {
    /// One-time setup. Records the admin used for moderation actions.
    ///
    /// `admin.require_auth()` is what stops the deployment being hijacked.
    /// Deploying and initializing are two separate transactions, so without it
    /// anyone watching the ledger could land their own `initialize` in the gap,
    /// become admin, and hold `admin_revoke` — the power to force-unbind any
    /// handle — permanently, since the registry can only be initialized once.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Hand moderation authority to `new_admin`. Requires the current admin.
    ///
    /// Without this the admin is write-once: a compromised or lost key would be
    /// permanent, and the only remedy would be redeploying the registry, which
    /// abandons every existing binding. Rotation is deliberately separate from
    /// contract upgradeability — the wasm stays immutable.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Self::bump_instance(&env);

        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "admin_changed"),),
            (admin, new_admin),
        );
        Ok(())
    }

    /// Bind `handle` to `wallet`. Requires the wallet's authorization, which
    /// is the cryptographic proof of ownership. Fails if the handle is already
    /// taken or the wallet already owns a handle.
    pub fn claim(env: Env, handle: String, wallet: Address) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        wallet.require_auth();
        validate_handle(&handle)?;
        if is_reserved_handle(&handle) {
            return Err(Error::HandleReserved);
        }

        let owner_key = DataKey::Owner(handle.clone());
        if env.storage().persistent().has(&owner_key) {
            return Err(Error::HandleTaken);
        }
        let wallet_key = DataKey::Handle(wallet.clone());
        if env.storage().persistent().has(&wallet_key) {
            return Err(Error::WalletAlreadyBound);
        }

        env.storage().persistent().set(&owner_key, &wallet);
        env.storage().persistent().set(&wallet_key, &handle);
        // Keep both directions of the binding alive for the same window.
        env.storage()
            .persistent()
            .extend_ttl(&owner_key, BUMP_THRESHOLD, BUMP_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&wallet_key, BUMP_THRESHOLD, BUMP_LEDGERS);

        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        env.storage().instance().set(&DataKey::Count, &(count + 1));
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("claimed"), handle), wallet);
        Ok(())
    }

    /// Transfer a handle to a new wallet. Requires authentication from the current owner.
    /// Fails if the handle is not found or if the target wallet already holds a handle.
    pub fn transfer_handle(env: Env, handle: String, new_wallet: Address) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        let current_owner =
            Self::resolve(env.clone(), handle.clone()).ok_or(Error::HandleNotFound)?;
        current_owner.require_auth();

        let new_wallet_key = DataKey::Handle(new_wallet.clone());
        if env.storage().persistent().has(&new_wallet_key) {
            return Err(Error::WalletAlreadyBound);
        }

        let owner_key = DataKey::Owner(handle.clone());
        let current_owner_key = DataKey::Handle(current_owner.clone());

        env.storage().persistent().remove(&current_owner_key);

        env.storage().persistent().set(&owner_key, &new_wallet);
        env.storage().persistent().set(&new_wallet_key, &handle);

        env.storage()
            .persistent()
            .extend_ttl(&owner_key, BUMP_THRESHOLD, BUMP_LEDGERS);
        env.storage()
            .persistent()
            .extend_ttl(&new_wallet_key, BUMP_THRESHOLD, BUMP_LEDGERS);
        Self::bump_instance(&env);

        env.events().publish(
            (soroban_sdk::Symbol::new(&env, "transferred"), handle),
            (current_owner, new_wallet),
        );

        Ok(())
    }

    /// Release a handle. Only the owning wallet may call this.
    pub fn release(env: Env, handle: String) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        let wallet = Self::resolve(env.clone(), handle.clone()).ok_or(Error::HandleNotFound)?;
        wallet.require_auth();
        Self::remove_binding(&env, &handle, &wallet, symbol_short!("released"));
        Ok(())
    }

    /// Force-remove a binding. Admin-only moderation escape hatch.
    pub fn admin_revoke(env: Env, handle: String) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        admin.require_auth();
        let wallet = Self::resolve(env.clone(), handle.clone()).ok_or(Error::HandleNotFound)?;
        Self::remove_binding(&env, &handle, &wallet, symbol_short!("revoked"));
        Ok(())
    }

    /// Resolve a handle to its owning wallet, if bound.
    pub fn resolve(env: Env, handle: String) -> Option<Address> {
        Self::bump_instance(&env);
        let key = DataKey::Owner(handle);
        let res: Option<Address> = env.storage().persistent().get(&key);
        if res.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_LEDGERS);
        }
        res
    }

    /// Reverse lookup: the handle a wallet owns, if any.
    pub fn lookup(env: Env, wallet: Address) -> Option<String> {
        Self::bump_instance(&env);
        let key = DataKey::Handle(wallet);
        let res: Option<String> = env.storage().persistent().get(&key);
        if res.is_some() {
            env.storage()
                .persistent()
                .extend_ttl(&key, BUMP_THRESHOLD, BUMP_LEDGERS);
        }
        res
    }

    /// Whether a handle is currently bound.
    pub fn is_bound(env: Env, handle: String) -> bool {
        Self::bump_instance(&env);
        env.storage().persistent().has(&DataKey::Owner(handle))
    }

    /// The binding counter: an O(1) UPPER BOUND on bound handles, not a live
    /// total. It is adjusted on `claim` and in `remove_binding`, but a binding
    /// whose persistent entries archive unaccessed runs no contract code, so
    /// nothing ever subtracts it — the counter can only drift upward, and
    /// there is no on-chain list to derive a true total from (enumerate via
    /// the event stream). Callers must present it as "recorded", never as
    /// "currently bound"; only `resolve` proves a specific binding is live.
    pub fn count(env: Env) -> u32 {
        Self::bump_instance(&env);
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// Resolve multiple handles to their owning wallets, positionally.
    ///
    /// Returns `None` for any handle that is not currently bound. Rejects
    /// batches larger than [`MAX_BATCH_SIZE`].
    pub fn resolve_batch(env: Env, handles: Vec<String>) -> Result<Vec<Option<Address>>, Error> {
        // Bump directly rather than relying on the per-handle resolve calls:
        // an empty batch is still someone using the registry.
        Self::bump_instance(&env);
        let len = handles.len();
        if len > MAX_BATCH_SIZE {
            return Err(Error::BatchTooLarge);
        }
        let mut results: Vec<Option<Address>> = Vec::new(&env);
        for handle in handles.iter() {
            let addr = Self::resolve(env.clone(), handle);
            results.push_back(addr);
        }
        Ok(results)
    }

    // ── internal ────────────────────────────────────────────────────────────

    /// Extend the contract instance's own TTL.
    ///
    /// `Admin` and `Count` live in instance storage, and the bindings' bumps in
    /// `persistent` storage do nothing for it. Left alone the instance would
    /// eventually archive, at which point `require_initialized` fails and every
    /// state-changing call reverts until someone restores it — the registry
    /// would look bricked while its bindings were still perfectly alive.
    /// Called from every entry point, reads included: a registry that people
    /// only *use* (resolve, lookup) during a quiet month with no claims must
    /// not archive out from under them, and claim volume is lowest exactly
    /// when the contract is newest. Reads count only when *invoked*, though —
    /// a simulated read discards its footprint and extends nothing — so a
    /// deployment whose traffic is all view-simulations still needs the
    /// keep-alive in the deployment runbook.
    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(BUMP_THRESHOLD, BUMP_LEDGERS);
    }

    fn require_initialized(env: &Env) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            Ok(())
        } else {
            Err(Error::NotInitialized)
        }
    }

    fn remove_binding(
        env: &Env,
        handle: &String,
        wallet: &Address,
        event_name: soroban_sdk::Symbol,
    ) {
        env.storage()
            .persistent()
            .remove(&DataKey::Owner(handle.clone()));
        env.storage()
            .persistent()
            .remove(&DataKey::Handle(wallet.clone()));

        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::Count, &count.saturating_sub(1));
        Self::bump_instance(env);

        env.events()
            .publish((event_name, handle.clone()), wallet.clone());
    }
}

/// Handles must be 1..=32 bytes of `[a-z0-9_-]`.
fn validate_handle(handle: &String) -> Result<(), Error> {
    let len = handle.len();
    if len == 0 || len > MAX_HANDLE_LEN {
        return Err(Error::InvalidHandle);
    }
    let mut buf = [0u8; MAX_HANDLE_LEN as usize];
    let slice = &mut buf[..len as usize];
    handle.copy_into_slice(slice);
    for &b in slice.iter() {
        let ok = b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-';
        if !ok {
            return Err(Error::InvalidHandle);
        }
    }
    Ok(())
}

/// True when `handle` matches a reserved app-route name (see `RESERVED_HANDLES`).
/// Runs after `validate_handle`, so the handle is already known to be within
/// length and charset — a byte compare against each reserved name suffices.
fn is_reserved_handle(handle: &String) -> bool {
    let len = handle.len() as usize;
    if len == 0 || len > MAX_HANDLE_LEN as usize {
        return false;
    }
    let mut buf = [0u8; MAX_HANDLE_LEN as usize];
    handle.copy_into_slice(&mut buf[..len]);
    let bytes = &buf[..len];
    for reserved in RESERVED_HANDLES.iter() {
        if bytes == reserved.as_bytes() {
            return true;
        }
    }
    false
}

mod property_test;
mod test;
