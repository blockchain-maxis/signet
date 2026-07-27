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
//! Enumeration of all handles is intentionally **off-chain**: the indexer
//! reconstructs the set from the `claimed`/`released` event stream. The
//! contract keeps only an O(1) `count` rather than an on-chain list, so storage
//! and per-call cost stay constant regardless of how many handles exist.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String,
};

/// Maximum handle length in bytes. Handles are short, URL-safe identifiers.
const MAX_HANDLE_LEN: u32 = 32;
/// Bump persistent entries by ~30 days (at ~5s ledgers) on access.
const BUMP_LEDGERS: u32 = 518_400;
/// Threshold below which an accessed entry gets bumped.
const BUMP_THRESHOLD: u32 = 86_400;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Registry admin (moderation authority).
    Admin,
    /// handle -> owning wallet `Address`.
    Owner(String),
    /// wallet `Address` -> handle.
    Handle(Address),
    /// Count of currently-bound handles (O(1); enumeration is via events).
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
}

#[contract]
pub struct IdentityRegistry;

#[contractimpl]
impl IdentityRegistry {
    /// One-time setup. Records the admin used for moderation actions.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Bind `handle` to `wallet`. Requires the wallet's authorization, which
    /// is the cryptographic proof of ownership. Fails if the handle is already
    /// taken or the wallet already owns a handle.
    pub fn claim(env: Env, handle: String, wallet: Address) -> Result<(), Error> {
        Self::require_initialized(&env)?;
        wallet.require_auth();
        validate_handle(&handle)?;

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

        env.events()
            .publish((symbol_short!("claimed"), handle), wallet);
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
        env.storage().persistent().has(&DataKey::Owner(handle))
    }

    /// Number of currently-bound handles. O(1); enumerate via the event stream.
    pub fn count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    // ── internal ────────────────────────────────────────────────────────────

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

mod test;
