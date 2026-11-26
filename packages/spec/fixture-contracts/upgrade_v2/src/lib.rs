#![no_std]

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, Env};

#[contracttype]
#[derive(Clone)]
pub struct Record {
    pub id: u32,
    pub active: bool,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Mode {
    Ready = 1,
    Paused = 2,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeError {
    NotFound = 1,
    Conflict = 2,
}

#[contractevent]
#[derive(Clone)]
pub struct Updated {
    #[topic]
    pub id: u32,
    #[topic]
    pub amount: u32,
    pub memo: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct Created {
    #[topic]
    pub id: u32,
    pub revision: u32,
}

#[contract]
pub struct UpgradeFixture;

#[contractimpl]
impl UpgradeFixture {
    /// Updates the amount.
    pub fn change_amount(env: Env, amount: u64) -> Result<u32, UpgradeError> {
        Updated {
            id: 0,
            amount: amount as u32,
            memo: 0,
        }
        .publish(&env);
        Created { id: 0, revision: 1 }.publish(&env);
        Ok(amount as u32)
    }

    /// Reads a record without changing its interface.
    pub fn read(_env: Env, record: Record, _mode: Mode) -> Record {
        record
    }

    /// Returns the current mode.
    pub fn set_mode(_env: Env) -> Mode {
        Mode::Ready
    }
}
