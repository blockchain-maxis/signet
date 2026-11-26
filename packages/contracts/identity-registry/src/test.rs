#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    symbol_short,
    testutils::{storage::Instance, Address as _, Events, Ledger, MockAuth, MockAuthInvoke},
    vec, xdr, Address, Env, IntoVal, String, Symbol, TryFromVal, Val, Vec,
};

fn last_events(env: &Env) -> Vec<(Vec<Val>, Val)> {
    let all = env.events().all();
    let mut out = Vec::new(env);
    for e in all.events() {
        match &e.body {
            xdr::ContractEventBody::V0(v0) => {
                let mut topics = Vec::new(env);
                for t in v0.topics.iter() {
                    topics.push_back(Val::try_from_val(env, t).unwrap());
                }
                let data = Val::try_from_val(env, &v0.data).unwrap();
                out.push_back((topics, data));
            }
        }
    }
    out
}

fn val_eq(env: &Env, a: &Val, b: &Val) -> bool {
    let a_xdr = xdr::ScVal::try_from_val(env, a).unwrap();
    let b_xdr = xdr::ScVal::try_from_val(env, b).unwrap();
    a_xdr == b_xdr
}

fn assert_single_event(env: &Env, expected_topics: Vec<Val>, expected_data: Val) {
    let events = last_events(env);
    assert_eq!(
        events.len(),
        1,
        "expected exactly one event to be published"
    );
    let (topics, data) = events.get(0).unwrap();
    assert_eq!(
        topics.len(),
        expected_topics.len(),
        "topics length mismatch"
    );
    for i in 0..topics.len() {
        let actual = topics.get(i).unwrap();
        let expected = expected_topics.get(i).unwrap();
        assert!(val_eq(env, &actual, &expected), "topic[{}] mismatch", i);
    }
    assert!(val_eq(env, &data, &expected_data), "event data mismatch");
}

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
fn initialize_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    assert_single_event(
        &env,
        vec![&env, Symbol::new(&env, "initialized").into_val(&env)],
        admin.into_val(&env),
    );
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
    assert_single_event(
        &env,
        vec![
            &env,
            symbol_short!("released").into_val(&env),
            handle.clone().into_val(&env),
        ],
        wallet.clone().into_val(&env),
    );

    assert!(!client.is_bound(&handle));
    assert_eq!(client.lookup(&wallet), None);
    assert_eq!(client.count(), 0);

    // Handle and wallet are reusable after release.
    client.claim(&handle, &wallet);
    assert!(client.is_bound(&handle));
}

#[test]
fn release_emits_event() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");
    client.claim(&handle, &wallet);

    client.release(&handle);
    assert_single_event(
        &env,
        vec![
            &env,
            symbol_short!("released").into_val(&env),
            handle.clone().into_val(&env),
        ],
        wallet.into_val(&env),
    );
}

#[test]
fn release_requires_owner_auth() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");
    client.claim(&handle, &wallet);

    client.release(&handle);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(
        auths[0].0, wallet,
        "release must be authorized by the owning wallet"
    );
}

#[test]
fn release_rejected_when_authorized_by_wrong_address() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let wallet = Address::generate(&env);
    let wrong = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");
    client.claim(&handle, &wallet);

    env.mock_auths(&[MockAuth {
        address: &wrong,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "release",
            args: (&handle,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_release(&handle);
    assert!(
        res.is_err(),
        "release must fail when authorized by wrong address"
    );
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
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "spammer");
    client.claim(&handle, &wallet);

    client.admin_revoke(&handle);
    assert_single_event(
        &env,
        vec![
            &env,
            symbol_short!("revoked").into_val(&env),
            handle.clone().into_val(&env),
        ],
        wallet.into_val(&env),
    );
    assert!(!client.is_bound(&handle));
}

#[test]
fn admin_revoke_emits_event() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "badactor");
    client.claim(&handle, &wallet);

    client.admin_revoke(&handle);
    assert_single_event(
        &env,
        vec![
            &env,
            symbol_short!("revoked").into_val(&env),
            handle.clone().into_val(&env),
        ],
        wallet.into_val(&env),
    );
}

#[test]
fn admin_revoke_requires_admin_auth() {
    let (env, client, admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "spammer");
    client.claim(&handle, &wallet);

    client.admin_revoke(&handle);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(
        auths[0].0, admin,
        "admin_revoke must be authorized by the stored admin"
    );
}

#[test]
fn admin_revoke_rejected_when_authorized_by_wrong_address() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);

    let wallet = Address::generate(&env);
    let wrong = Address::generate(&env);
    let handle = String::from_str(&env, "spammer");
    client.claim(&handle, &wallet);

    env.mock_auths(&[MockAuth {
        address: &wrong,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "admin_revoke",
            args: (&handle,).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = client.try_admin_revoke(&handle);
    assert!(
        res.is_err(),
        "admin_revoke must fail when authorized by non-admin"
    );
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
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");
    client.claim(&handle, &wallet);
    assert_single_event(
        &env,
        vec![
            &env,
            symbol_short!("claimed").into_val(&env),
            handle.clone().into_val(&env),
        ],
        wallet.into_val(&env),
    );
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
    // must be read before any further client calls. A transfer moves the binding on
    // behalf of both wallets, so both must have authorized it.
    let auths = env.auths();
    assert_eq!(auths.len(), 2);
    assert_eq!(auths[0].0, old_wallet);
    assert_eq!(auths[1].0, new_wallet);

    // Verify event was emitted
    assert_single_event(
        &env,
        vec![
            &env,
            Symbol::new(&env, "transferred").into_val(&env),
            handle.clone().into_val(&env),
        ],
        (old_wallet.clone(), new_wallet.clone()).into_val(&env),
    );

    // Bindings updated correctly
    assert_eq!(client.resolve(&handle), Some(new_wallet.clone()));
    assert_eq!(client.lookup(&new_wallet), Some(handle.clone()));
    assert_eq!(client.lookup(&old_wallet), None);
    assert!(client.is_bound(&handle));

    // Count is preserved
    assert_eq!(client.count(), 1);
}

#[test]
fn transfer_handle_emits_event() {
    let (env, client, _admin) = setup();
    let old_wallet = Address::generate(&env);
    let new_wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");

    client.claim(&handle, &old_wallet);
    client.transfer_handle(&handle, &new_wallet);

    assert_single_event(
        &env,
        vec![
            &env,
            Symbol::new(&env, "transferred").into_val(&env),
            handle.clone().into_val(&env),
        ],
        (old_wallet, new_wallet).into_val(&env),
    );
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
fn transfer_handle_requires_new_wallet_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env));

    let old_wallet = Address::generate(&env);
    let new_wallet = Address::generate(&env);
    let handle = String::from_str(&env, "aquawolf");
    client.claim(&handle, &old_wallet);

    // Only the current owner signs: the new wallet has not agreed to the
    // binding, and a handle must not be pushed onto it.
    env.mock_auths(&[MockAuth {
        address: &old_wallet,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "transfer_handle",
            args: (handle.clone(), new_wallet.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let res = client.try_transfer_handle(&handle, &new_wallet);
    assert!(
        res.is_err(),
        "a transfer without the new wallet's auth must fail"
    );

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
        "link",
        "www",
        "status",
        "support",
        "mail",
        "blog",
        "static",
        "assets",
        "cdn",
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
    for name in [
        "apps",
        "apiv2",
        "administrator",
        "profiles",
        "links",
        "www2",
    ] {
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

// ── admin authority ───────────────────────────────────────────────────────

#[test]
fn initialize_requires_admin_auth() {
    // The hijack this prevents: deploy and initialize are separate
    // transactions, so without an auth requirement anyone could land their own
    // `initialize` in the gap and own `admin_revoke` forever.
    let env = Env::default();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);

    env.mock_all_auths();
    client.initialize(&admin);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(
        auths[0].0, admin,
        "initialize must be authorized by the admin"
    );
}

#[test]
#[should_panic]
fn initialize_without_authorization_panics() {
    // No `mock_all_auths`, so `require_auth` has nothing to satisfy it.
    let env = Env::default();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env));
}

#[test]
fn set_admin_rotates_authority() {
    let (env, client, _admin) = setup();
    let new_admin = Address::generate(&env);
    let handle = String::from_str(&env, "spammer");
    client.claim(&handle, &Address::generate(&env));

    client.set_admin(&new_admin);

    // The rotated admin can moderate — proving the stored authority changed.
    client.admin_revoke(&handle);
    assert!(!client.is_bound(&handle));
}

#[test]
fn set_admin_requires_current_admin_auth() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);

    client.set_admin(&new_admin);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(
        auths[0].0, admin,
        "rotation must be authorized by the outgoing admin, not the incoming one"
    );
}

#[test]
fn set_admin_before_initialize_errors() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);

    let res = client.try_set_admin(&Address::generate(&env));
    assert_eq!(res, Err(Ok(Error::NotInitialized)));
}

#[test]
fn set_admin_emits_event() {
    let (env, client, admin) = setup();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    assert_single_event(
        &env,
        vec![&env, Symbol::new(&env, "admin_changed").into_val(&env)],
        (admin, new_admin).into_val(&env),
    );
}

// ── migration reservations & seal (issue #982) ───────────────────────────────

#[test]
fn reserve_then_claim_by_named_wallet_succeeds_and_consumes_reservation() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "reserveduser");

    client.admin_reserve(&handle, &wallet);

    // Named wallet successfully claims
    client.claim(&handle, &wallet);
    assert_eq!(client.resolve(&handle), Some(wallet.clone()));
    assert_eq!(client.count(), 1);

    // Release the handle; reservation was consumed on claim, so another wallet can now claim it
    client.release(&handle);
    let other_wallet = Address::generate(&env);
    client.claim(&handle, &other_wallet);
    assert_eq!(client.resolve(&handle), Some(other_wallet));
}

#[test]
fn admin_reserve_emits_event() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "reserveduser");
    client.admin_reserve(&handle, &wallet);
    assert_single_event(
        &env,
        vec![
            &env,
            Symbol::new(&env, "reserved").into_val(&env),
            handle.into_val(&env),
        ],
        wallet.into_val(&env),
    );
}

#[test]
fn seal_emits_event() {
    let (env, client, _admin) = setup();
    client.seal();
    assert_single_event(
        &env,
        vec![&env, Symbol::new(&env, "sealed").into_val(&env)],
        ().into_val(&env),
    );
}

#[test]
fn claim_by_other_wallet_fails_with_handle_reserved_for_other() {
    let (env, client, _admin) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let handle = String::from_str(&env, "aliceonly");

    client.admin_reserve(&handle, &alice);

    let res = client.try_claim(&handle, &bob);
    assert_eq!(res, Err(Ok(Error::HandleReservedForOther)));
}

#[test]
fn admin_reserve_requires_admin_auth() {
    let (env, client, admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "resauth");

    client.admin_reserve(&handle, &wallet);
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, admin);

    // Drop blanket auth: call without admin auth fails
    env.set_auths(&[]);
    let res = client.try_admin_reserve(&handle, &wallet);
    assert!(res.is_err());
}

#[test]
fn admin_reserve_of_bound_handle_fails() {
    let (env, client, _admin) = setup();
    let wallet1 = Address::generate(&env);
    let wallet2 = Address::generate(&env);
    let handle = String::from_str(&env, "alreadytaken");

    client.claim(&handle, &wallet1);

    let res = client.try_admin_reserve(&handle, &wallet2);
    assert_eq!(res, Err(Ok(Error::HandleTaken)));
}

#[test]
fn admin_reserve_after_seal_fails() {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    let handle = String::from_str(&env, "toolate");

    client.seal();

    let res = client.try_admin_reserve(&handle, &wallet);
    assert_eq!(res, Err(Ok(Error::RegistrySealed)));
}

#[test]
fn after_seal_leftover_reservation_no_longer_blocks_anyone() {
    let (env, client, _admin) = setup();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let handle = String::from_str(&env, "leftover");

    // Reserve for Alice
    client.admin_reserve(&handle, &alice);

    // End migration
    client.seal();

    // Now Bob can claim even though the reservation was for Alice
    client.claim(&handle, &bob);
    assert_eq!(client.resolve(&handle), Some(bob));
}

#[test]
fn seal_requires_admin_auth_and_second_seal_fails() {
    let (env, client, admin) = setup();

    client.seal();
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, admin);

    // Second seal fails with RegistrySealed
    let res = client.try_seal();
    assert_eq!(res, Err(Ok(Error::RegistrySealed)));

    // Fresh registry without admin auth fails
    let (env2, client2, _admin2) = setup();
    env2.set_auths(&[]);
    let res2 = client2.try_seal();
    assert!(res2.is_err());
}

// ── instance TTL (issue #187) ───────────────────────────────────────────────

/// The instance TTL as seen from inside the contract, in ledgers-remaining.
fn instance_ttl(env: &Env, client: &IdentityRegistryClient) -> u32 {
    env.as_contract(&client.address, || env.storage().instance().get_ttl())
}

/// Age the ledger until the instance TTL is below the bump threshold — the
/// point where the next `bump_instance` actually extends rather than no-ops —
/// while staying safely short of archival.
fn age_instance_to_threshold(env: &Env) {
    env.ledger().with_mut(|li| {
        li.sequence_number += BUMP_LEDGERS - BUMP_THRESHOLD + 1;
    });
}

/// Claim a handle, age the instance to the bump threshold, run `read`, and
/// assert the read extended the instance TTL like a write would.
fn assert_read_bumps_instance(read: impl Fn(&Env, &IdentityRegistryClient, &Address)) {
    let (env, client, _admin) = setup();
    let wallet = Address::generate(&env);
    client.claim(&String::from_str(&env, "aquawolf"), &wallet);

    age_instance_to_threshold(&env);
    assert!(
        instance_ttl(&env, &client) < BUMP_THRESHOLD,
        "fixture: instance must be below the bump threshold before the read"
    );

    read(&env, &client, &wallet);
    assert_eq!(
        instance_ttl(&env, &client),
        BUMP_LEDGERS,
        "read entry point did not extend the instance TTL"
    );
}

#[test]
fn every_read_keeps_the_instance_alive() {
    // A registry that people only USE — resolve, lookup, is_bound, count —
    // during a quiet month with no claims must not archive out from under
    // them. Each read entry point must extend the instance TTL exactly like
    // the writes do. (Invoked reads only: simulations discard footprints, so
    // the deployment runbook's keep-alive covers view-only deployments.)
    assert_read_bumps_instance(|env, c, _| {
        c.resolve(&String::from_str(env, "aquawolf"));
    });
    assert_read_bumps_instance(|_, c, wallet| {
        c.lookup(wallet);
    });
    assert_read_bumps_instance(|env, c, _| {
        c.is_bound(&String::from_str(env, "aquawolf"));
    });
    assert_read_bumps_instance(|_, c, _| {
        c.count();
    });
    assert_read_bumps_instance(|env, c, _| {
        let mut batch: Vec<String> = Vec::new(env);
        batch.push_back(String::from_str(env, "aquawolf"));
        c.resolve_batch(&batch);
    });
    // Even an EMPTY batch is someone using the registry.
    assert_read_bumps_instance(|env, c, _| {
        c.resolve_batch(&Vec::new(env));
    });
}

#[test]
fn a_missed_read_still_keeps_the_instance_alive() {
    // The bump must not depend on the read finding anything: an unbound
    // resolve or is_bound is still someone using the registry.
    let (env, client, _admin) = setup();

    age_instance_to_threshold(&env);
    assert!(instance_ttl(&env, &client) < BUMP_THRESHOLD);

    assert_eq!(client.resolve(&String::from_str(&env, "nobody-here")), None);
    assert_eq!(instance_ttl(&env, &client), BUMP_LEDGERS);
}

// ── declared events (#981) ──────────────────────────────────────────────────

/// One `eventV0` spec entry, reduced to what a consumer reads from the wasm.
fn event_spec(
    spec_xdr: &[u8],
) -> (
    std::string::String,
    std::vec::Vec<std::string::String>,
    xdr::ScSpecEventDataFormat,
    std::vec::Vec<(std::string::String, xdr::ScSpecEventParamLocationV0)>,
) {
    use xdr::ReadXdr;
    let entry = xdr::ScSpecEntry::from_xdr(spec_xdr, xdr::Limits::none()).unwrap();
    let xdr::ScSpecEntry::EventV0(event) = entry else {
        panic!("expected an eventV0 spec entry");
    };
    (
        event.name.to_utf8_string().unwrap(),
        event
            .prefix_topics
            .iter()
            .map(|t| t.to_utf8_string().unwrap())
            .collect(),
        event.data_format,
        event
            .params
            .iter()
            .map(|p| (p.name.to_utf8_string().unwrap(), p.location))
            .collect(),
    )
}

/// The `#[contractevent]` structs are what put `eventV0` entries into the
/// wasm's `contractspecv0` section, so these are the events a spec reader
/// (Signet's docs view, `stellar contract info interface`) lists for the
/// registry. The names, prefix topics, data formats and param locations must
/// match the published layout pinned by the `*_emits_event` tests above.
#[test]
fn contract_spec_declares_every_event() {
    use xdr::ScSpecEventDataFormat::{SingleValue, Vec as VecFormat};
    use xdr::ScSpecEventParamLocationV0::{Data, TopicList};
    let s = |v: &str| std::string::String::from(v);

    assert_eq!(
        event_spec(&Claimed::spec_xdr()),
        (
            s("Claimed"),
            vec_of(&["claimed"]),
            SingleValue,
            std::vec![(s("handle"), TopicList), (s("wallet"), Data)]
        )
    );
    assert_eq!(
        event_spec(&Released::spec_xdr()),
        (
            s("Released"),
            vec_of(&["released"]),
            SingleValue,
            std::vec![(s("handle"), TopicList), (s("wallet"), Data)]
        )
    );
    assert_eq!(
        event_spec(&Revoked::spec_xdr()),
        (
            s("Revoked"),
            vec_of(&["revoked"]),
            SingleValue,
            std::vec![(s("handle"), TopicList), (s("wallet"), Data)]
        )
    );
    assert_eq!(
        event_spec(&Transferred::spec_xdr()),
        (
            s("Transferred"),
            vec_of(&["transferred"]),
            VecFormat,
            std::vec![(s("handle"), TopicList), (s("from"), Data), (s("to"), Data)]
        )
    );
    assert_eq!(
        event_spec(&AdminChanged::spec_xdr()),
        (
            s("AdminChanged"),
            vec_of(&["admin_changed"]),
            VecFormat,
            std::vec![(s("old_admin"), Data), (s("new_admin"), Data)]
        )
    );
    assert_eq!(
        event_spec(&Initialized::spec_xdr()),
        (
            s("Initialized"),
            vec_of(&["initialized"]),
            SingleValue,
            std::vec![(s("admin"), Data)]
        )
    );
    assert_eq!(
        event_spec(&Reserved::spec_xdr()),
        (
            s("Reserved"),
            vec_of(&["reserved"]),
            SingleValue,
            std::vec![(s("handle"), TopicList), (s("wallet"), Data)]
        )
    );
    assert_eq!(
        event_spec(&Sealed::spec_xdr()),
        (s("Sealed"), vec_of(&["sealed"]), SingleValue, std::vec![])
    );
}

fn vec_of(items: &[&str]) -> std::vec::Vec<std::string::String> {
    items
        .iter()
        .map(|i| std::string::String::from(*i))
        .collect()
}
