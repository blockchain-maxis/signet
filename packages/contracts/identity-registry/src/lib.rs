// TODO(signet): replace with IdentityRegistry implementation
//
// This is the standard Soroban "Hello World" contract, kept only so the
// crate compiles to wasm32 and the workspace is wired up. The real
// IdentityRegistry will bind a Stellar wallet to a Signet identity:
//   - store attestation records (wallet -> handle)
//   - verify the wallet owner's signature over the binding payload
//   - expose read methods the indexer can use to resolve identities
#![no_std]
use soroban_sdk::{contract, contractimpl, vec, Env, String, Vec};

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    pub fn hello(env: Env, to: String) -> Vec<String> {
        vec![&env, String::from_str(&env, "Hello"), to]
    }
}

mod test;
