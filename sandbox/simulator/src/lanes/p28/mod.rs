//! The protocol 28 lane: `soroban-env-host` 28.0.2 and `soroban-simulation`
//! 28.0.2 (sandbox/Cargo.toml), running the shared lane source.

use soroban_env_host_p28 as soroban_env_host;
use soroban_simulation_p28 as soroban_simulation;

/// The ledger protocol this lane runs: the pinned host's interface version.
pub const LEDGER_PROTOCOL: u32 = 28;
pub const ENV_HOST_VERSION: &str = "28.0.2";
pub const SIMULATION_VERSION: &str = "28.0.2";

// Every lane compiles the same spec source against its own host, on
// purpose: the module is per lane, the file is shared.
#[allow(clippy::duplicate_mod)]
#[path = "../spec_impl.rs"]
mod spec;

#[allow(clippy::duplicate_mod)]
#[path = "../diff_impl.rs"]
mod diff;

pub mod snapshot;

include!("../host_lane.rs");
