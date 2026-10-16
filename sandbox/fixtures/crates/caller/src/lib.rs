#![no_std]

use soroban_sdk::{contract, contractimpl, vec, Address, Env, IntoVal, Symbol};

#[contract]
pub struct Caller;

#[contractimpl]
impl Caller {
    pub fn call_add(env: Env, callee: Address, a: u32, b: u32) -> u32 {
        env.invoke_contract(
            &callee,
            &Symbol::new(&env, "add"),
            vec![&env, a.into_val(&env), b.into_val(&env)],
        )
    }
}
