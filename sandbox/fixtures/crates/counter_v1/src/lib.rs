#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, BytesN, Env};

#[contract]
pub struct CounterV1;

#[contractimpl]
impl CounterV1 {
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
        new_count
    }

    pub fn get(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }

    #[allow(deprecated)]
    pub fn upgrade(env: Env, hash: BytesN<32>) {
        env.deployer().update_current_contract_wasm(hash);
    }
}
