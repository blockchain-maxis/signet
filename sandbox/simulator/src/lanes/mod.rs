//! Protocol lanes (#533).
//!
//! A production `soroban-env-host` only runs at the ledger protocol equal to
//! its own `INTERFACE_VERSION`, and every host version brings its own
//! `stellar-xdr` types. Serving two protocols at once (#538) therefore means
//! the rest of the simulator must never hold one version's Rust types: it
//! talks to a [`Lane`] through XDR bytes and plain Rust values only, and each
//! lane decodes those bytes with its own XDR crate.
//!
//! This module is that boundary. Nothing outside `lanes/` may name
//! `soroban_env_host`, `soroban_simulation` or `stellar_xdr`; the
//! `no_versioned_types_outside_lanes` test enforces it.
//!
//! [`LaneRegistry::for_protocol`] picks the lane for a ledger, or answers with
//! [`UnsupportedLedgerProtocol`], which the dispatcher turns into the
//! catalogue's `unsupported_ledger_protocol` error.

use std::rc::Rc;

pub mod p28;

// ─── Bytes in, bytes out ───────────────────────────────────────────────────────

/// The ledger a lane simulates against, as XDR bytes. `get` answers a
/// `LedgerKey`'s bytes with the live `LedgerEntry`'s bytes and its
/// `live_until` ledger, or `None` for anything the host must not touch
/// (absent, deleted, or archived).
pub trait ByteSnapshotSource {
    fn get(&self, key_xdr: &[u8]) -> Option<(Rc<[u8]>, Option<u32>)>;
}

/// One `InvokeHostFunction` simulation request.
// Built by #534's `simulate` handler; exercised by the lane tests until then.
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct SimulateBytes {
    pub network_passphrase: String,
    pub sequence: u32,
    /// Ledger close time, Unix seconds.
    pub timestamp: u64,
    /// `HostFunction` XDR.
    pub host_function_xdr: Vec<u8>,
    /// `AccountId` XDR of the invoking account.
    pub source_account_xdr: Vec<u8>,
    pub prng_seed: [u8; 32],
    pub enable_diagnostics: bool,
}

/// One ledger entry a simulation created, updated or deleted.
#[allow(dead_code)] // consumed by #534's simulate handler.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryChangeBytes {
    /// `LedgerKey` XDR.
    pub key_xdr: Vec<u8>,
    /// `LedgerEntry` XDR after the run; `None` when the run deleted it.
    pub entry_xdr: Option<Vec<u8>>,
}

/// What a simulation produced, as XDR bytes.
#[allow(dead_code)] // consumed by #534's simulate handler.
#[derive(Clone, Debug)]
pub struct SimulateResultBytes {
    /// The returned `ScVal` XDR, or the host error's text when the
    /// invocation itself failed (a contract error, not a lane failure).
    pub return_value: Result<Vec<u8>, String>,
    /// `ContractEvent` XDR, in emission order. Empty for failed invocations.
    pub contract_events_xdr: Vec<Vec<u8>>,
    /// `DiagnosticEvent` XDR; populated only when diagnostics were enabled.
    pub diagnostic_events_xdr: Vec<Vec<u8>>,
    /// Recorded `SorobanAuthorizationEntry` XDR.
    pub auth_xdr: Vec<Vec<u8>>,
    /// `SorobanTransactionData` XDR with resources and fee; `None` on failure.
    pub transaction_data_xdr: Option<Vec<u8>>,
    pub cpu_instructions: u32,
    pub memory_bytes: u32,
    pub modified_entries: Vec<EntryChangeBytes>,
}

/// The outcome of pointing a contract instance at another executable.
#[allow(dead_code)] // consumed by the `contract_swap` handler.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapResultBytes {
    /// The rewritten instance `LedgerEntry` XDR.
    pub entry_xdr: Vec<u8>,
    pub previous_wasm_hash: [u8; 32],
}

/// A ledger entry Go wants to ask RPC for, named without XDR (#532). Strkeys
/// stay strings here: decoding them is the lane's job, like any other XDR.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyRequest {
    /// A contract's instance entry (`C...` strkey).
    ContractInstance { contract_id: String },
    /// An uploaded executable, by its SHA-256.
    ContractCode { wasm_hash: [u8; 32] },
    /// A classic account (`G...` strkey).
    Account { account_id: String },
    /// One `ConfigSettingId`, by its XDR name (`ContractMaxSizeBytes`).
    ConfigSetting { setting: String },
    /// Every `ConfigSetting` entry the lane's `NetworkConfig` loads (#535).
    NetworkConfig,
}

/// One derived `LedgerKey`, with what it addresses in plain terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DerivedKey {
    /// `contract_instance`, `contract_code`, `account` or `config_setting`.
    pub kind: &'static str,
    /// The contract id, hex hash, account id or setting name it was built from.
    pub subject: String,
    pub key_xdr: Vec<u8>,
}

/// What an executable declares, read without running it (#540).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WasmInspection {
    pub wasm_hash: [u8; 32],
    pub size_bytes: usize,
    /// Every custom section's name, in file order.
    pub custom_sections: Vec<String>,
    /// `contractenvmetav0`'s interface version, if the section declares one.
    pub interface_version: Option<InterfaceVersion>,
    /// Exported function names, in file order.
    pub exports: Vec<String>,
    /// Imported functions as `(module, name)`, in file order: the host
    /// functions the executable calls.
    pub imports: Vec<(String, String)>,
}

/// A Soroban environment interface version: the ledger protocol, and a
/// pre-release number that is zero for anything that can run on a network.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InterfaceVersion {
    pub protocol: u32,
    pub pre_release: u32,
}

/// Why a lane could not do what it was asked. Contract failures are not lane
/// failures: they come back inside [`SimulateResultBytes::return_value`].
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LaneError {
    /// Bytes that do not decode as the named XDR type.
    #[error("not a valid {what} for ledger protocol {protocol}")]
    InvalidXdr { what: &'static str, protocol: u32 },
    /// The ledger lacks the network configuration entries a simulation needs
    /// (the fork must fetch the `ConfigSetting` entries).
    #[error("network configuration is unavailable: {0}")]
    NetworkConfig(String),
    /// The entry is not a contract instance running a WASM executable.
    #[error("not a WASM contract instance entry")]
    NotAContractInstance,
    /// The executable could not be read as WASM, or its spec section is malformed.
    #[error("invalid contract executable: {0}")]
    InvalidWasm(String),
    /// The simulation could not be set up or accounted (not a contract error).
    #[error("simulation failed: {0}")]
    Simulation(String),
    /// A plain-text input the lane decodes itself (a strkey, a setting name)
    /// that it does not recognise.
    #[error("{what} is not valid: {detail}")]
    InvalidInput { what: &'static str, detail: String },
}

// ─── The lane ──────────────────────────────────────────────────────────────────

/// One ledger protocol's host. Every argument and result is XDR bytes or a
/// plain Rust value, so callers never depend on a versioned XDR crate.
pub trait Lane: Sync {
    /// The ledger protocol this lane runs, equal to its host's interface version.
    fn ledger_protocol(&self) -> u32;
    /// Pinned `soroban-env-host` version, reported in `hello_ack`.
    fn env_host_version(&self) -> &'static str;
    /// Pinned `soroban-simulation` version, reported in `hello_ack`.
    fn simulation_version(&self) -> &'static str;

    /// Whether `key_xdr` is a `LedgerKey` this lane can decode.
    fn check_ledger_key(&self, key_xdr: &[u8]) -> Result<(), LaneError>;
    /// Whether `entry_xdr` is a `LedgerEntry` this lane can decode.
    fn check_ledger_entry(&self, entry_xdr: &[u8]) -> Result<(), LaneError>;

    /// Run one `InvokeHostFunction` against `src` in recording mode.
    #[allow(dead_code)] // called by #534's simulate handler.
    fn simulate(
        &self,
        request: &SimulateBytes,
        src: Rc<dyn ByteSnapshotSource>,
    ) -> Result<SimulateResultBytes, LaneError>;

    /// The `LedgerKey` XDR of a contract's instance entry.
    #[allow(dead_code)] // called by the `contract_swap` handler.
    fn contract_instance_key(&self, contract_id: [u8; 32]) -> Vec<u8>;

    /// Point a contract instance entry at the executable `wasm_hash`, as an
    /// upgrade would, keeping its storage.
    #[allow(dead_code)] // called by the `contract_swap` handler.
    fn swap(
        &self,
        instance_entry_xdr: &[u8],
        wasm_hash: [u8; 32],
    ) -> Result<SwapResultBytes, LaneError>;

    /// The `ScSpecEntry` XDR entries in an executable's `contractspecv0`
    /// section, in declaration order; empty when the section is absent.
    #[allow(dead_code)] // called by the `spec_*` handlers (#545).
    fn spec_entries(&self, wasm: &[u8]) -> Result<Vec<Vec<u8>>, LaneError>;

    /// The `LedgerKey` XDR for each entry `request` names; `NetworkConfig`
    /// expands to one key per setting, the rest to exactly one (`xdr_keys`).
    fn ledger_keys(&self, request: &KeyRequest) -> Result<Vec<DerivedKey>, LaneError>;

    /// A `TransactionEnvelope`, and optionally the `TransactionMeta` RPC's
    /// `getTransaction` returned for it, decoded to JSON (`tx_decode`). The
    /// shape is the `transaction` object in schema/v1/tx_decode.json.
    fn decode_transaction(
        &self,
        envelope_xdr: &[u8],
        meta_xdr: Option<&[u8]>,
    ) -> Result<serde_json::Value, LaneError>;

    /// What an executable declares (`wasm_inspect`).
    fn inspect_wasm(&self, wasm: &[u8]) -> Result<WasmInspection, LaneError>;
}

// ─── Registry ──────────────────────────────────────────────────────────────────

/// A requested ledger protocol no lane in this binary runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsupportedLedgerProtocol {
    pub requested: u32,
    pub supported: Vec<u32>,
}

/// The lanes this binary carries, newest last.
pub struct LaneRegistry {
    lanes: &'static [&'static dyn Lane],
}

static BUILTIN: [&dyn Lane; 1] = [&p28::P28];

impl LaneRegistry {
    pub fn builtin() -> Self {
        Self { lanes: &BUILTIN }
    }

    /// The lane for `ledger_protocol`, or which protocols are on offer.
    pub fn for_protocol(
        &self,
        ledger_protocol: u32,
    ) -> Result<&'static dyn Lane, UnsupportedLedgerProtocol> {
        self.lanes
            .iter()
            .copied()
            .find(|lane| lane.ledger_protocol() == ledger_protocol)
            .ok_or_else(|| UnsupportedLedgerProtocol {
                requested: ledger_protocol,
                supported: self.supported(),
            })
    }

    /// The lane `ledger_open` uses when no protocol is named.
    pub fn newest(&self) -> &'static dyn Lane {
        self.lanes
            .iter()
            .copied()
            .max_by_key(|lane| lane.ledger_protocol())
            .expect("a simulator build carries at least one lane")
    }

    pub fn supported(&self) -> Vec<u32> {
        let mut protocols: Vec<u32> = self.lanes.iter().map(|l| l.ledger_protocol()).collect();
        protocols.sort_unstable();
        protocols
    }

    pub fn lanes(&self) -> impl Iterator<Item = &'static dyn Lane> {
        self.lanes.iter().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn protocol_28_resolves_to_the_p28_lane() {
        let lane = LaneRegistry::builtin().for_protocol(28).unwrap();
        assert_eq!(lane.ledger_protocol(), 28);
        assert_eq!(lane.env_host_version(), "28.0.2");
        assert_eq!(lane.simulation_version(), "28.0.2");
    }

    #[test]
    fn protocol_29_is_unsupported_and_names_what_is() {
        let err = LaneRegistry::builtin().for_protocol(29).err().unwrap();
        assert_eq!(
            err,
            UnsupportedLedgerProtocol {
                requested: 29,
                supported: vec![28],
            }
        );
    }

    #[test]
    fn the_newest_lane_is_the_default() {
        let registry = LaneRegistry::builtin();
        assert_eq!(registry.newest().ledger_protocol(), 28);
        assert_eq!(registry.supported(), vec![28]);
    }

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// The store, the verbs and the dispatcher must compile without any
    /// versioned host or XDR type: only `lanes/` may name those crates.
    #[test]
    fn no_versioned_types_outside_lanes() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let lanes = src.join("lanes");
        let mut files = Vec::new();
        rust_files(&src, &mut files);

        let forbidden = ["soroban_env_host", "soroban_simulation", "stellar_xdr"];
        let mut offenders = Vec::new();
        for file in files.iter().filter(|f| !f.starts_with(&lanes)) {
            let text = std::fs::read_to_string(file).unwrap();
            for (n, line) in text.lines().enumerate() {
                if forbidden.iter().any(|crate_name| line.contains(crate_name)) {
                    offenders.push(format!("{}:{}: {}", file.display(), n + 1, line.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "versioned host/XDR types used outside lanes/:\n{}",
            offenders.join("\n")
        );
        // Guard the guard: it must actually have scanned the store and dispatcher.
        assert!(files.iter().any(|f| f.ends_with("store.rs")));
        assert!(files.iter().any(|f| f.ends_with("dispatch.rs")));
    }
}
