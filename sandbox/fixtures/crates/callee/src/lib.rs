#![no_std]

use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct Callee;

#[contractimpl]
impl Callee {
    pub fn add(_env: Env, a: u32, b: u32) -> u32 {
        a + b
    }
}
