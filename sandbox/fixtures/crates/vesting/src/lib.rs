#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct Vesting;

#[contractimpl]
impl Vesting {
    pub fn is_unlocked(env: Env, unlock_time: u64) -> bool {
        env.ledger().timestamp() >= unlock_time
    }

    pub fn claim(env: Env, unlock_time: u64) -> bool {
        if env.ledger().timestamp() >= unlock_time {
            let claimed: bool = env
                .storage()
                .instance()
                .get(&symbol_short!("claimed"))
                .unwrap_or(false);
            if claimed {
                panic!("already claimed");
            }
            env.storage()
                .instance()
                .set(&symbol_short!("claimed"), &true);
            true
        } else {
            panic!("vesting lock not reached");
        }
    }
}
