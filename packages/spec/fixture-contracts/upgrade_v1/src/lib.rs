#![no_std]

use soroban_sdk::{contract, contracterror, contractevent, contractimpl, contracttype, Env};

#[contracttype]
#[derive(Clone)]
pub struct Record {
    pub id: u32,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Mode {
    Ready = 1,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum UpgradeError {
    NotFound = 1,
}

#[contractevent]
#[derive(Clone)]
pub struct Updated {
    #[topic]
    pub id: u32,
    pub amount: u32,
    pub memo: u32,
}

#[contract]
pub struct UpgradeFixture;

#[contractimpl]
impl UpgradeFixture {
    /// Changes the amount.
    pub fn change_amount(env: Env, amount: u32) -> Result<u32, UpgradeError> {
        Updated {
            id: 0,
            amount,
            memo: 0,
        }
        .publish(&env);
        Ok(amount)
    }

    /// Reads a record without changing its interface.
    pub fn read(_env: Env, record: Record, _mode: Mode) -> Record {
        record
    }
}
