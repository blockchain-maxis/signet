//! The protocol 29 lane: `soroban-env-host` 29.0.2 and `soroban-simulation`
//! 29.0.2 (sandbox/Cargo.toml), running the shared lane source.

use soroban_env_host_p29 as soroban_env_host;
use soroban_simulation_p29 as soroban_simulation;

/// The ledger protocol this lane runs: the pinned host's interface version.
pub const LEDGER_PROTOCOL: u32 = 29;
pub const ENV_HOST_VERSION: &str = "29.0.2";
pub const SIMULATION_VERSION: &str = "29.0.2";

// Every lane compiles the same spec source against its own host, on
// purpose: the module is per lane, the file is shared.
#[allow(clippy::duplicate_mod)]
#[path = "../spec_impl.rs"]
mod spec;

include!("../host_lane.rs");
