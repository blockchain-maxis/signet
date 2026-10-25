#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct CounterV2Write;

#[contractimpl]
impl CounterV2Write {
    pub fn increment(env: Env) -> u32 {
        let count: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&symbol_short!("count"), &new_count);
        // The one change from counter_v1: an extra persistent write.
        env.storage()
            .persistent()
            .set(&symbol_short!("last"), &new_count);
        new_count
    }

    pub fn get(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }
}
