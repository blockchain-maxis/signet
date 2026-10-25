#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct CounterV2Cost;

#[contractimpl]
impl CounterV2Cost {
    pub fn increment(env: Env) -> u32 {
        // Seeded from the ledger so the optimizer cannot fold the loop
        // away (it did, when the loop summed constants): the cost is real.
        let mut dummy: u64 = env.ledger().sequence() as u64;
        for i in 0..10_000u64 {
            dummy = dummy.wrapping_mul(31).wrapping_add(i ^ (dummy >> 7));
        }
        let count: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0);
        let new_count = count + 1 + (dummy == 0) as u32;
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
