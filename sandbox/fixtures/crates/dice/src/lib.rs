#![no_std]

use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct Dice;

#[contractimpl]
impl Dice {
    /// A value from the host's PRNG: the same for the same seed, different
    /// for another, which is what deterministic execution tests (#537) need.
    pub fn roll(env: Env) -> u64 {
        env.prng().gen()
    }
}
