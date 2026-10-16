#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

#[contract]
pub struct CounterV2Auth;

#[contractimpl]
impl CounterV2Auth {
    pub fn increment(env: Env, caller: Address) -> u32 {
        caller.require_auth();
        let count: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&symbol_short!("count"), &new_count);
        new_count
    }

    pub fn get(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }
}
