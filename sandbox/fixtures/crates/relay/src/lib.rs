#![no_std]

use soroban_sdk::{contract, contractimpl, vec, Address, Env, IntoVal, Symbol};

#[contract]
pub struct Relay;

#[contractimpl]
impl Relay {
    /// Calls `increment(user)` on a counter_v2_auth contract, so `user`'s
    /// `require_auth` happens below the root invocation: non-root auth, which
    /// strict auth mode refuses (#557).
    pub fn bump(env: Env, target: Address, user: Address) -> u32 {
        env.invoke_contract(
            &target,
            &Symbol::new(&env, "increment"),
            vec![&env, user.into_val(&env)],
        )
    }
}
