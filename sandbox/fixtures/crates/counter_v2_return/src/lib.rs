#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct CounterV2Return;

#[contractimpl]
impl CounterV2Return {
    pub fn increment(env: Env) -> i128 {
        let count: i128 = env
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

    pub fn get(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }
}
