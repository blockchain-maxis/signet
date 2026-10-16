#![no_std]

use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct Looper;

#[contractimpl]
impl Looper {
    #[allow(clippy::empty_loop)]
    pub fn run(_env: Env) {
        loop {}
    }
}
