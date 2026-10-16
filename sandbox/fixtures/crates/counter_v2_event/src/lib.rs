#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, symbol_short, Env};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Incremented {
    pub count: u32,
}

#[contract]
pub struct CounterV2Event;

#[contractimpl]
impl CounterV2Event {
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
        Incremented { count: new_count }.publish(&env);
        new_count
    }

    pub fn get(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }
}
