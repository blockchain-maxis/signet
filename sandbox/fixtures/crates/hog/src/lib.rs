#![no_std]

use soroban_sdk::{contract, contractimpl, Env, Vec};

#[contract]
pub struct Hog;

#[contractimpl]
impl Hog {
    pub fn allocate(env: Env, count: u32) {
        let mut v = Vec::<u32>::new(&env);
        for i in 0..count {
            v.push_back(i);
        }
    }
}
