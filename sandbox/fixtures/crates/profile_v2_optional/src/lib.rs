#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Env, String};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Profile {
    pub id: u32,
    pub name: String,
    pub bio: Option<String>,
}

#[contract]
pub struct ProfileV2Optional;

#[contractimpl]
impl ProfileV2Optional {
    pub fn set_profile(env: Env, profile: Profile) {
        env.storage()
            .instance()
            .set(&symbol_short!("profile"), &profile);
    }

    pub fn get_profile(env: Env) -> Profile {
        env.storage()
            .instance()
            .get(&symbol_short!("profile"))
            .expect("profile not found")
    }
}
