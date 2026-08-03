#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, String, Vec,
};

fn setup() -> (Env, IdentityRegistryClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

#[test]
fn claim_binds_handle_to_wallet() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");

    client.claim(&handle, &wallet);

    assert_eq!(client.resolve(&handle), Some(wallet.clone()));
    assert_eq!(client.lookup(&wallet), Some(handle.clone()));
    assert!(client.is_bound(&handle));
    assert_eq!(client.count(), 1);
}

#[test]
fn claim_requires_wallet_auth() {
    let env = Env::default();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    env.mock_all_auths();
    client.initialize(&admin);

    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "sorobuilder");
    client.claim(&handle, &wallet);

    // The most recent auth recorded must be the wallet authorizing `claim`.
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, wallet);
}

#[test]
fn claim_rejects_duplicate_handle() {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "stellardev");
    client.claim(&handle, &Address::generate(&env));

    let res = client.try_claim(&handle, &Address::generate(&env));
    assert_eq!(res, Err(Ok(Error::HandleTaken)));
}

#[test]
fn claim_rejects_wallet_with_existing_handle() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    client.claim(&String::from_str(&env, "first"), &wallet);

    let res = client.try_claim(&String::from_str(&env, "second"), &wallet);
    assert_eq!(res, Err(Ok(Error::WalletAlreadyBound)));
}

#[test]
fn claim_rejects_invalid_handles() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);

    // empty
    assert_eq!(
        client.try_claim(&String::from_str(&env, ""), &wallet),
        Err(Ok(Error::InvalidHandle))
    );
    // uppercase
    assert_eq!(
        client.try_claim(&String::from_str(&env, "AquaWolf"), &wallet),
        Err(Ok(Error::InvalidHandle))
    );
    // disallowed punctuation
    assert_eq!(
        client.try_claim(&String::from_str(&env, "bad handle!"), &wallet),
        Err(Ok(Error::InvalidHandle))
    );
    // too long (33 chars)
    assert_eq!(
        client.try_claim(
            &String::from_str(&env, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            &wallet
        ),
        Err(Ok(Error::InvalidHandle))
    );
}

#[test]
fn valid_handle_charset_is_accepted() {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "dev_01-x");
    client.claim(&handle, &Address::generate(&env));
    assert!(client.is_bound(&handle));
}

#[test]
fn release_frees_handle_and_wallet() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");
    client.claim(&handle, &wallet);

    client.release(&handle);

    assert!(!client.is_bound(&handle));
    assert_eq!(client.lookup(&wallet), None);
    assert_eq!(client.count(), 0);

    // Handle and wallet are reusable after release.
    client.claim(&handle, &wallet);
    assert!(client.is_bound(&handle));
}

#[test]
fn release_unknown_handle_errors() {
    let (env, client, _admin) = setup();
    let res = client.try_release(&String::from_str(&env, "ghost"));
    assert_eq!(res, Err(Ok(Error::HandleNotFound)));
}

#[test]
fn admin_revoke_removes_binding() {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "spammer");
    client.claim(&handle, &Address::generate(&env));

    client.admin_revoke(&handle);
    // `env.events()` only reflects the most recent invocation, so the `revoked` event
    // must be asserted before any further client call.
    assert!(!env.events().all().events().is_empty());
    assert!(!client.is_bound(&handle));
}

#[test]
fn initialize_is_one_time() {
    let (env, client, _admin) = setup();
    let res = client.try_initialize(&Address::generate(&env));
    assert_eq!(res, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn claim_before_initialize_errors() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let res = client.try_claim(&String::from_str(&env, "early"), &Address::generate(&env));
    assert_eq!(res, Err(Ok(Error::NotInitialized)));
}

#[test]
fn claim_emits_event() {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "aquawolf");
    client.claim(&handle, &Address::generate(&env));
    // At least one event was published by the claim.
    assert!(!env.events().all().events().is_empty());
}

#[test]
fn count_tracks_active_bindings() {
    let (env, client, _admin) = setup();
    client.claim(&String::from_str(&env, "a"), &Address::generate(&env));
    client.claim(&String::from_str(&env, "b"), &Address::generate(&env));
    client.claim(&String::from_str(&env, "c"), &Address::generate(&env));
    assert_eq!(client.count(), 3);

    client.release(&String::from_str(&env, "b"));
    assert_eq!(client.count(), 2);
    // Membership is queryable per-handle; full enumeration is via events.
    assert!(client.is_bound(&String::from_str(&env, "a")));
    assert!(!client.is_bound(&String::from_str(&env, "b")));
    assert!(client.is_bound(&String::from_str(&env, "c")));
}

#[test]
fn count_never_underflows() {
    let (env, client, _admin) = setup();
    assert_eq!(client.count(), 0);
    let handle = String::from_str(&env, "solo");
    client.claim(&handle, &Address::generate(&env));
    client.release(&handle);
    assert_eq!(client.count(), 0);
}

#[test]
fn transfer_handle_happy_path() {
    let (env, client, _admin) = setup();
    let old_wallet = Address::generate(&env);
    let new_wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");

    client.claim(&handle, &old_wallet);
    assert_eq!(client.count(), 1);
    assert_eq!(client.resolve(&handle), Some(old_wallet.clone()));
    assert_eq!(client.lookup(&old_wallet), Some(handle.clone()));

    client.transfer_handle(&handle, &new_wallet);

    // `env.auths()` and `env.events()` only reflect the most recent invocation, so both
    // must be read before any further client calls.
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, old_wallet);

    // Verify event was emitted
    assert!(!env.events().all().events().is_empty());

    // Bindings updated correctly
    assert_eq!(client.resolve(&handle), Some(new_wallet.clone()));
    assert_eq!(client.lookup(&new_wallet), Some(handle.clone()));
    assert_eq!(client.lookup(&old_wallet), None);
    assert!(client.is_bound(&handle));

    // Count is preserved
    assert_eq!(client.count(), 1);
}

#[test]
fn transfer_handle_requires_current_owner_auth() {
    let (env, client, _admin) = setup();
    let old_wallet = Address::generate(&env);
    let new_wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");

    client.claim(&handle, &old_wallet);

    // Drop the blanket auth mock: nobody authorizes the transfer.
    env.set_auths(&[]);
    let res = client.try_transfer_handle(&handle, &new_wallet);
    assert!(res.is_err());

    // The binding is untouched.
    env.mock_all_auths();
    assert_eq!(client.resolve(&handle), Some(old_wallet.clone()));
    assert_eq!(client.lookup(&old_wallet), Some(handle.clone()));
    assert_eq!(client.lookup(&new_wallet), None);
    assert_eq!(client.count(), 1);
}

#[test]
fn transfer_handle_unknown_handle_errors() {
    let (env, client, _admin) = setup();
    let new_wallet = Address::generate(&env);
    let handle = String::from_str(&env, "ghost");

    let res = client.try_transfer_handle(&handle, &new_wallet);
    assert_eq!(res, Err(Ok(Error::HandleNotFound)));
}

#[test]
fn transfer_handle_target_wallet_already_bound_errors() {
    let (env, client, _admin) = setup();
    let old_wallet = Address::generate(&env);
    let target_wallet = Address::generate(&env);
    let handle1 = String::from_str(&env, "handle1");
    let handle2 = String::from_str(&env, "handle2");

    client.claim(&handle1, &old_wallet);
    client.claim(&handle2, &target_wallet);

    // Attempting to transfer handle1 to target_wallet which already owns handle2
    let res = client.try_transfer_handle(&handle1, &target_wallet);
    assert_eq!(res, Err(Ok(Error::WalletAlreadyBound)));

    // Ensure state remained unchanged
    assert_eq!(client.resolve(&handle1), Some(old_wallet.clone()));
    assert_eq!(client.lookup(&old_wallet), Some(handle1.clone()));
    assert_eq!(client.count(), 2);
}

#[test]
fn claim_rejects_reserved_handles() {
    let (env, client, _admin) = setup();

    // Every reserved app-route name must be rejected, and none may bind.
    for name in [
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
    ] {
        let handle = String::from_str(&env, name);
        let res = client.try_claim(&handle, &Address::generate(&env));
        assert_eq!(res, Err(Ok(Error::HandleReserved)));
        assert!(!client.is_bound(&handle));
    }

    assert_eq!(client.count(), 0);
}

#[test]
fn claim_allows_handles_that_only_resemble_reserved_names() {
    let (env, client, _admin) = setup();

    // Reservation is exact-match: superstrings of reserved names are fine.
    for name in ["apps", "apiv2", "administrator", "profiles"] {
        let handle = String::from_str(&env, name);
        client.claim(&handle, &Address::generate(&env));
        assert!(client.is_bound(&handle));
    }
}

#[test]
fn resolve_batch_returns_positional_results() {
    let (env, client, _admin) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let handle_a = String::from_str(&env, "alice");
    let handle_b = String::from_str(&env, "bob");

    client.claim(&handle_a, &alice);
    client.claim(&handle_b, &bob);

    let mut handles = Vec::new(&env);
    handles.push_back(handle_a.clone());
    handles.push_back(handle_b.clone());

    let results = client.resolve_batch(&handles);

    assert_eq!(results.len(), 2);
    assert_eq!(results.get(0).unwrap(), Some(alice));
    assert_eq!(results.get(1).unwrap(), Some(bob));
}

#[test]
fn resolve_batch_unbound_returns_none() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle_a = String::from_str(&env, "bound");
    let handle_b = String::from_str(&env, "ghost");

    client.claim(&handle_a, &wallet);

    let mut handles = Vec::new(&env);
    handles.push_back(handle_a.clone());
    handles.push_back(handle_b.clone());

    let results = client.resolve_batch(&handles);

    assert_eq!(results.len(), 2);
    assert_eq!(results.get(0).unwrap(), Some(wallet));
    assert_eq!(results.get(1).unwrap(), None);
}

#[test]
fn resolve_batch_empty_returns_empty() {
    let (env, client, _admin) = setup();
    let handles: Vec<String> = Vec::new(&env);
    let results = client.resolve_batch(&handles);
    assert_eq!(results.len(), 0);
}

#[test]
fn resolve_batch_rejects_oversized() {
    let (env, client, _admin) = setup();
    let mut handles = Vec::new(&env);
    for _ in 0..=MAX_BATCH_SIZE {
        handles.push_back(String::from_str(&env, "h"));
    }
    let res = client.try_resolve_batch(&handles);
    assert_eq!(res, Err(Ok(Error::BatchTooLarge)));
}
