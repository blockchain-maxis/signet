#![cfg(test)]
//! Property and fuzz tests for the Identity Registry.
//!
//! The unit tests in `test.rs` pin down known cases: this module states the
//! *rules* those cases are examples of, and lets proptest search for a
//! counter-example — including the inputs nobody thinks to write down.
//!
//! Three properties are covered, chosen because each one guards something the
//! rest of the system trusts without re-checking:
//!
//!   1. **Handle validation is exactly its specification.** `validate_handle`
//!      is the contract's only input sanitiser, and what it accepts is what can
//!      appear in a URL, a subdomain and a routing table forever after. It is
//!      checked against an independent oracle over arbitrary *byte* strings —
//!      not just the ASCII ones a hand-written test would reach for — so a
//!      length-bound off-by-one or a charset hole shows up as a shrunk,
//!      reproducible failure.
//!   2. **`resolve_batch` is bounded and positional** across the whole range
//!      either side of `MAX_BATCH_SIZE`, rather than at the two sizes a unit
//!      test happens to pick.
//!   3. **`count` equals the number of live bindings** after *any* sequence of
//!      claim / release / transfer / revoke, including the calls that fail. The
//!      count is stored, not derived, so every write path has to maintain it —
//!      and a single path that forgets makes the number silently wrong for the
//!      rest of the registry's life.
//!
//! Each property runs against a fresh `Env`, so these exercise live-ledger
//! behaviour only. The known archival-driven count drift is out of reach of the
//! test host and is not what these assert.

extern crate std;

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig},
    Address, Env, String, Vec,
};
use std::collections::BTreeMap;
use std::vec::Vec as StdVec;

/// A test `Env` with snapshot capture switched off.
///
/// The SDK writes a `test_snapshots/{test}.N.json` file per `Env` dropped in a
/// test. That is exactly right for the fixed unit tests, whose snapshots are
/// committed and watched for change — and exactly wrong here, where every
/// property runs hundreds of generated cases: it would write hundreds of files
/// per run, differing run to run with the inputs proptest happened to pick.
fn env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

fn registry() -> (Env, IdentityRegistryClient<'static>) {
    let env = env();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    client.initialize(&Address::generate(&env));
    (env, client)
}

/// Independent restatement of the handle rule: 1..=32 bytes of `[a-z0-9_-]`.
///
/// Deliberately written from the documented spec rather than by reusing any of
/// the contract's own helpers — an oracle that shares the implementation's bug
/// agrees with it.
fn spec_says_valid(bytes: &[u8]) -> bool {
    !bytes.is_empty()
        && bytes.len() <= MAX_HANDLE_LEN as usize
        && bytes
            .iter()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}

fn is_reserved(bytes: &[u8]) -> bool {
    RESERVED_HANDLES.iter().any(|r| r.as_bytes() == bytes)
}

// ── 1. handle validation ──────────────────────────────────────────────────

proptest! {
    /// Arbitrary bytes, including non-UTF-8 and NUL: `validate_handle` accepts
    /// exactly the strings the spec accepts, and never panics on the rest.
    /// `copy_into_slice` writes into a fixed 32-byte buffer, so an over-long
    /// input that got past the length check would be a panic, not a rejection.
    #[test]
    fn validate_handle_matches_the_spec_on_arbitrary_bytes(
        bytes in proptest::collection::vec(any::<u8>(), 0..64),
    ) {
        let env = env();
        let handle = String::from_bytes(&env, &bytes);
        prop_assert_eq!(
            validate_handle(&handle).is_ok(),
            spec_says_valid(&bytes),
            "disagreed on {:?}",
            bytes
        );
    }

    /// The same rule over arbitrary text, which is where multi-byte UTF-8 comes
    /// from: `é` is two bytes and `字` three, so a handle can be well under 32
    /// *characters* and still over 32 bytes. The bound is a byte bound, and
    /// non-ASCII is outside the charset either way.
    #[test]
    fn validate_handle_rejects_non_ascii_text(text in ".{0,40}") {
        let env = env();
        let handle = String::from_bytes(&env, text.as_bytes());
        prop_assert_eq!(
            validate_handle(&handle).is_ok(),
            spec_says_valid(text.as_bytes())
        );
    }

    /// The length bound alone, with the charset held valid, across the whole
    /// boundary region: accepted up to and including exactly 32 bytes, rejected
    /// from 33.
    #[test]
    fn validate_handle_length_bound_is_inclusive_at_32(handle in "[a-z0-9_-]{1,48}") {
        let env = env();
        let built = String::from_bytes(&env, handle.as_bytes());
        prop_assert_eq!(
            validate_handle(&built).is_ok(),
            handle.len() <= MAX_HANDLE_LEN as usize
        );
    }

    /// The entrypoint enforces the same rule the helper does. `claim` is where
    /// validation actually matters, and it is reachable with any string a
    /// caller cares to submit — so a bad handle must come back as
    /// `InvalidHandle`, not as a panic and not as a binding.
    #[test]
    fn claim_rejects_exactly_the_handles_validation_rejects(
        bytes in proptest::collection::vec(any::<u8>(), 0..40),
    ) {
        let (env, client) = registry();
        let handle = String::from_bytes(&env, &bytes);
        let res = client.try_claim(&handle, &Address::generate(&env));

        if !spec_says_valid(&bytes) {
            prop_assert_eq!(res, Err(Ok(Error::InvalidHandle)));
            prop_assert_eq!(client.count(), 0);
        } else if is_reserved(&bytes) {
            prop_assert_eq!(res, Err(Ok(Error::HandleReserved)));
            prop_assert_eq!(client.count(), 0);
        } else {
            prop_assert!(res.is_ok());
            prop_assert!(client.is_bound(&handle));
            prop_assert_eq!(client.count(), 1);
        }
    }
}

// ── 2. resolve_batch bounds ───────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Batches are rejected above `MAX_BATCH_SIZE` and answered positionally at
    /// or below it — checked across the whole range either side of the bound,
    /// so an off-by-one at exactly 100 or 101 cannot hide.
    #[test]
    fn resolve_batch_is_bounded_and_positional(n in 0u32..MAX_BATCH_SIZE + 30) {
        let (env, client) = registry();
        let wallet = Address::generate(&env);
        let bound = String::from_str(&env, "bound");
        let unbound = String::from_str(&env, "ghost");
        client.claim(&bound, &wallet);

        // Alternating bound / unbound, so a result read from the wrong index is
        // visible rather than coincidentally correct.
        let mut handles = Vec::new(&env);
        for i in 0..n {
            handles.push_back(if i % 2 == 0 { bound.clone() } else { unbound.clone() });
        }

        let res = client.try_resolve_batch(&handles);

        if n > MAX_BATCH_SIZE {
            prop_assert_eq!(res, Err(Ok(Error::BatchTooLarge)));
        } else {
            let results = res.unwrap().unwrap();
            prop_assert_eq!(results.len(), n);
            for i in 0..n {
                let expected = if i % 2 == 0 { Some(wallet.clone()) } else { None };
                prop_assert_eq!(results.get(i).unwrap(), expected);
            }
        }
    }
}

// ── 3. the count invariant ────────────────────────────────────────────────

/// One registry mutation, over a small fixed pool of handles and wallets.
///
/// The pool is deliberately small: the interesting cases are collisions —
/// claiming a taken handle, transferring to an already-bound wallet, releasing
/// nothing — and a wide pool would almost never produce them.
#[derive(Debug, Clone, Copy)]
enum Op {
    Claim { handle: usize, wallet: usize },
    Release { handle: usize },
    Transfer { handle: usize, wallet: usize },
    Revoke { handle: usize },
}

const POOL: usize = 5;
const HANDLE_NAMES: [&str; POOL] = ["alpha", "bravo", "charlie", "delta", "echo"];

fn any_op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0..POOL, 0..POOL).prop_map(|(handle, wallet)| Op::Claim { handle, wallet }),
        (0..POOL).prop_map(|handle| Op::Release { handle }),
        (0..POOL, 0..POOL).prop_map(|(handle, wallet)| Op::Transfer { handle, wallet }),
        (0..POOL).prop_map(|handle| Op::Revoke { handle }),
    ]
}

/// The handle index a wallet index currently owns, per the model.
fn owner_of(model: &BTreeMap<usize, usize>, wallet: usize) -> Option<usize> {
    model.iter().find(|(_, &w)| w == wallet).map(|(&h, _)| h)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// After any sequence of writes — the failing ones included — `count`
    /// equals the number of live bindings, and both directions of every binding
    /// agree with a plain in-memory model of what should have happened.
    ///
    /// This is the invariant the whole 1:1 design rests on: `count` is stored
    /// rather than derived (enumeration is off-chain, via events), so every
    /// write path has to maintain it by hand, and a rejected call must leave it
    /// untouched.
    #[test]
    fn count_equals_live_bindings_after_any_sequence(
        ops in proptest::collection::vec(any_op(), 1..24),
    ) {
        let (env, client) = registry();
        let wallets: StdVec<Address> = (0..POOL).map(|_| Address::generate(&env)).collect();
        let handles: StdVec<String> =
            HANDLE_NAMES.iter().map(|n| String::from_str(&env, n)).collect();

        // The model: handle index -> owning wallet index. The reverse binding is
        // read back out of it, mirroring the contract's two-key storage.
        let mut model: BTreeMap<usize, usize> = BTreeMap::new();

        for (step, op) in ops.iter().enumerate() {
            match *op {
                Op::Claim { handle, wallet } => {
                    let should_fail =
                        model.contains_key(&handle) || owner_of(&model, wallet).is_some();
                    let res = client.try_claim(&handles[handle], &wallets[wallet]);
                    prop_assert_eq!(res.is_err(), should_fail, "claim at step {}", step);
                    if !should_fail {
                        model.insert(handle, wallet);
                    }
                }
                Op::Release { handle } => {
                    let should_fail = !model.contains_key(&handle);
                    let res = client.try_release(&handles[handle]);
                    prop_assert_eq!(res.is_err(), should_fail, "release at step {}", step);
                    model.remove(&handle);
                }
                Op::Transfer { handle, wallet } => {
                    // A transfer to an already-bound wallet is refused, and the
                    // current owner is itself bound — so transferring a handle
                    // to the wallet already holding it is a failure, not a no-op
                    // success.
                    let should_fail =
                        !model.contains_key(&handle) || owner_of(&model, wallet).is_some();
                    let res = client.try_transfer_handle(&handles[handle], &wallets[wallet]);
                    prop_assert_eq!(res.is_err(), should_fail, "transfer at step {}", step);
                    if !should_fail {
                        model.insert(handle, wallet);
                    }
                }
                Op::Revoke { handle } => {
                    let should_fail = !model.contains_key(&handle);
                    let res = client.try_admin_revoke(&handles[handle]);
                    prop_assert_eq!(res.is_err(), should_fail, "revoke at step {}", step);
                    model.remove(&handle);
                }
            }

            // The invariant, re-checked after every op rather than only at the
            // end, so a failure names the exact call that broke it.
            prop_assert_eq!(
                client.count(),
                model.len() as u32,
                "count drifted at step {}",
                step
            );

            // ...and the count only means anything if it counts *these*
            // bindings, in both directions.
            for h in 0..POOL {
                let expected = model.get(&h).map(|&w| wallets[w].clone());
                prop_assert_eq!(client.resolve(&handles[h]), expected.clone());
                prop_assert_eq!(client.is_bound(&handles[h]), expected.is_some());
            }
            for w in 0..POOL {
                let expected = owner_of(&model, w).map(|h| handles[h].clone());
                prop_assert_eq!(client.lookup(&wallets[w]), expected);
            }
        }
    }
}
