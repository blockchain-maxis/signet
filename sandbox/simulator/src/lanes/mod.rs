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

#[cfg(feature = "lane-p28")]
pub mod p28;

/// A `stellar snapshot create` file read (#554): only the p28 lane carries
/// the reader.
#[cfg(feature = "lane-p28")]
pub use p28::snapshot::read_snapshot;

/// A ledger snapshot's ledger and entries, as plain values and XDR bytes.
#[cfg(feature = "lane-p28")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotBytes {
    pub protocol_version: u32,
    pub sequence_number: u32,
    pub timestamp: u64,
    pub network_id: [u8; 32],
    pub base_reserve: u32,
    pub min_persistent_entry_ttl: u32,
    pub min_temp_entry_ttl: u32,
    pub max_entry_ttl: u32,
    pub entries: Vec<SnapshotEntryBytes>,
}

/// One snapshot entry in the pieces RPC gives: key, data, ext, last
/// modified, live until.
#[cfg(feature = "lane-p28")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SnapshotEntryBytes {
    pub key_xdr: Vec<u8>,
    pub data_xdr: Vec<u8>,
    pub ext_xdr: Vec<u8>,
    pub last_modified_ledger_seq: u32,
    pub live_until: Option<u32>,
}
#[cfg(feature = "lane-p29")]
pub mod p29;

#[cfg(not(any(feature = "lane-p28", feature = "lane-p29")))]
compile_error!("signet-simulator needs at least one lane feature (lane-p28, lane-p29)");

// ─── Bytes in, bytes out ───────────────────────────────────────────────────────

/// The ledger a lane simulates against, as XDR bytes. `get` answers a
/// `LedgerKey`'s bytes with the live `LedgerEntry`'s bytes and its
/// `live_until` ledger, or `None` for anything the host must not touch
/// (absent, deleted, or archived).
///
/// `Err` means the source could not answer at all (a `ledger_fetch` Go
/// refused, or a miss in deny mode). The lane aborts the run; the source
/// keeps the reason, and the caller reports it instead of the host's error.
pub trait ByteSnapshotSource {
    fn get(&self, key_xdr: &[u8]) -> SourceResult;
}

/// What a [`ByteSnapshotSource`] answers: an entry's XDR and `live_until`,
/// nothing, or a source that gave up.
pub type SourceResult = Result<Option<(Rc<[u8]>, Option<u32>)>, SourceFailed>;

/// A snapshot source that gave up; the reason stays with the source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceFailed;

/// One `InvokeHostFunction` simulation request.
#[derive(Clone, Debug)]
pub struct SimulateBytes {
    pub network_passphrase: String,
    pub sequence: u32,
    /// Ledger close time, Unix seconds.
    pub timestamp: u64,
    /// The network's base reserve, in stroops (not an on-ledger setting).
    pub base_reserve: u32,
    /// `HostFunction` XDR.
    pub host_function_xdr: Vec<u8>,
    /// `AccountId` XDR of the invoking account.
    pub source_account_xdr: Vec<u8>,
    pub prng_seed: [u8; 32],
    pub enable_diagnostics: bool,
    /// Budget overrides (#536); `None` keeps the network's limits.
    pub budget: Option<BudgetOverride>,
    /// How `require_auth` is answered (#557).
    pub auth: AuthMode,
}

/// How a simulation answers `require_auth` (#557).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum AuthMode {
    /// Approve every `require_auth` and record what it would have needed,
    /// at any depth. Signatures are not checked.
    #[default]
    Record,
    /// Record, but refuse auth required below the root invocation, as the
    /// network does when no entry covers it (custom accounts, nested auth).
    Strict,
    /// Check these pre-signed `SorobanAuthorizationEntry`s, as the network
    /// would. Signet signs nothing itself.
    Enforce(Vec<Vec<u8>>),
}

/// A caller's budget for one call. Either limit may stay the network's.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BudgetOverride {
    pub instructions: Option<u64>,
    pub mem_bytes: Option<u64>,
    /// A limit not given is the ceiling rather than the network's (#558).
    pub unlimited: bool,
}

/// How far a budget override may go: this many times the network's limit.
/// Past it a runaway call could hold the terminal for minutes; the wall
/// clock is Go's to enforce (docs/CLI_RUST_BRIDGE.md §4).
pub const BUDGET_CEILING_FACTOR: u64 = 10;

/// The limits a call ran under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectiveBudget {
    pub instructions: u64,
    pub mem_bytes: u64,
    pub overridden: bool,
}

/// One ledger entry a simulation created, updated or deleted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryChangeBytes {
    /// `LedgerKey` XDR.
    pub key_xdr: Vec<u8>,
    /// `LedgerEntry` XDR before the run; `None` when the run created it.
    pub before_xdr: Option<Vec<u8>>,
    /// `LedgerEntry` XDR after the run; `None` when the run deleted it.
    pub entry_xdr: Option<Vec<u8>>,
    /// The entry's `live_until` after the run: unchanged for an existing
    /// entry, the network's minimum TTL for a new one.
    pub live_until: Option<u32>,
}

/// An invocation that ran and failed: the contract returned an error, or the
/// host trapped (budget, a panic in the contract, a missing entry).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvocationFailure {
    /// The `contracterror` code, when the contract itself said no.
    pub contract_code: Option<u32>,
    /// The host's error type and code (`Contract`, `3`; `Budget`, `ExceededLimit`).
    pub error_type: String,
    pub error_code: String,
    /// The host's own description, for the message.
    pub detail: String,
}

/// What a `SorobanTransactionData` says the call needs and costs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransactionResources {
    pub instructions: u32,
    pub disk_read_bytes: u32,
    pub write_bytes: u32,
    /// Footprint `LedgerKey` XDR.
    pub read_only: Vec<Vec<u8>>,
    pub read_write: Vec<Vec<u8>>,
    pub resource_fee: i64,
}

/// A contract instance, read without running it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceInfo {
    /// `wasm`, `stellar_asset` or `external_ref` (CAP-85).
    pub executable: &'static str,
    /// The executable's hash, for a WASM contract.
    pub wasm_hash: Option<[u8; 32]>,
    /// For an `external_ref` contract: the owner's `ExecutableTag` entry key
    /// that holds the hash of the WASM it runs, and the owner and tag.
    pub external_ref: Option<ExternalRef>,
    /// Entries in the instance's own storage map.
    pub storage_entries: usize,
    /// For a Stellar Asset Contract, the asset its `METADATA` names:
    /// `native`, or `CODE:ISSUER` (#552).
    pub asset: Option<String>,
}

/// A CAP-85 executable reference, as plain values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalRef {
    pub owner: String,
    pub tag: String,
    /// `LedgerKey` XDR of the owner's entry holding the WASM hash.
    pub key_xdr: Vec<u8>,
}

/// A contract set up by `contract_install`: the entries to write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Installed {
    pub contract_id: String,
    pub wasm_hash: [u8; 32],
    /// `(LedgerKey XDR, LedgerEntry XDR)` for the code and the instance.
    pub entries: Vec<(Vec<u8>, Vec<u8>)>,
}

/// One side of an A/B comparison (#568): what a call produced, as XDR.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffSide {
    /// The returned `ScVal` XDR; `None` when the call failed.
    pub return_value: Option<Vec<u8>>,
    /// `ContractEvent` XDR, in emission order (diagnostic events left out).
    pub events: Vec<Vec<u8>>,
    /// The entries the call wrote.
    pub writes: Vec<DiffWrite>,
    /// `SorobanAuthorizationEntry` XDR, as recorded.
    pub auth: Vec<Vec<u8>>,
}

/// One entry a call wrote: its `LedgerKey` XDR, the `LedgerEntry` XDR it
/// left (`None` when it deleted the entry), and its TTL.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffWrite {
    pub key_xdr: Vec<u8>,
    pub entry_xdr: Option<Vec<u8>>,
    pub live_until: Option<u32>,
}

/// What an A/B diff leaves out (#569).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffRules {
    /// Event topic prefixes: an event whose first topics read these is
    /// ignored.
    pub ignore_events: Vec<Vec<String>>,
    /// Storage key patterns in the #559 key syntax, `*` for any value.
    pub ignore_storage: Vec<String>,
    /// The executable whose spec reads the patterns' enum cases.
    pub spec_wasm: Option<Vec<u8>>,
}

/// A replay that failed on the new build where the deployed code ran it:
/// evidence for the storage-layout check (#571).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayoutReplay {
    pub name: String,
    /// The new build's error code, `Error(Object, UnexpectedType)`.
    pub error: String,
    /// `LedgerKey` XDR the deployed code read on the same call.
    pub keys: Vec<Vec<u8>>,
}

/// What a simulation produced, as XDR bytes.
#[derive(Clone, Debug)]
pub struct SimulateResultBytes {
    /// The returned `ScVal` XDR, or how the invocation failed (a contract
    /// or host error, not a lane failure).
    pub return_value: Result<Vec<u8>, InvocationFailure>,
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
    /// The budget the call ran under.
    pub budget: EffectiveBudget,
}

/// One contract call in a simulation, read from the host's `fn_call` and
/// `fn_return` diagnostic events (#541), in call order (pre-order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceCall {
    /// The called contract (C...).
    pub contract: String,
    pub function: String,
    /// Index of the calling frame; `None` for the root call.
    pub parent: Option<usize>,
    pub depth: u32,
    /// The arguments as the event carries them: the host records one
    /// argument as itself and several folded into a vec, so `items_xdr`
    /// holds that vec's elements when `data_xdr` is one, and the callee's
    /// spec decides which reading is right.
    pub data_xdr: Vec<u8>,
    pub items_xdr: Option<Vec<Vec<u8>>>,
    /// The returned `ScVal` XDR; `None` when the call failed.
    pub result_xdr: Option<Vec<u8>>,
    /// Why the call failed, as `Error(Type, Code)` when the host said.
    pub error: Option<String>,
}

/// What a storage key or value may be written as (#559), for messages.
pub const STORAGE_SHAPES: &str = "Variant or Variant(arg, …) (a #[contracttype] enum case), a typed value like u32:5 or address:\"G…\", typed ScVal JSON like {\"symbol\":\"Admin\"}, or a JSON string or bool";

/// Where a contract keeps a value (#559).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Durability {
    Instance,
    Persistent,
    Temporary,
}

/// One `--set-storage` / `--unset-storage` (#559).
pub struct StorageOverride<'a> {
    /// The contract's executable, for its spec; overrides without one read
    /// keys and values without types from a spec.
    pub wasm: Option<&'a [u8]>,
    pub contract_id: &'a str,
    pub durability: Durability,
    pub key: &'a str,
    /// `None` removes the key.
    pub value: Option<&'a str>,
    /// The contract's instance entry, which an instance override rewrites.
    pub instance_entry: Option<&'a [u8]>,
}

/// The write an override makes: the entry at `key_xdr`, or its removal.
pub struct StorageWrite {
    pub key_xdr: Vec<u8>,
    pub entry_xdr: Option<Vec<u8>>,
    /// The overridden key in words.
    pub describe: String,
}

/// The outcome of pointing a contract instance at another executable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapResultBytes {
    /// The rewritten `LedgerEntry` XDR: the instance, or for a retargeted
    /// CAP-85 reference, the owner's `ExecutableTag` entry.
    pub entry_xdr: Vec<u8>,
    /// What the entry pointed at before; `None` for an instance that ran
    /// through an executable reference (the reference entry knows).
    pub previous_wasm_hash: Option<[u8; 32]>,
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
    /// `wasm`, `executable-ref` or `none`: whether the executable can replace
    /// its own code on-chain (#540), read from its imports.
    pub upgradeable: &'static str,
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
    /// A JSON argument that does not fit the type the contract's spec
    /// declares (#545). `path` names it (`wallet`, `handles[2]`).
    #[error("{path}: expected {expected}, got {got}")]
    Argument {
        path: String,
        expected: String,
        got: String,
    },
    /// A value that does not have the type the spec says it should (#546).
    #[allow(dead_code)] // raised by spec_decode_val (#546).
    #[error("{0}")]
    Decode(String),
}

/// What [`Lane::decode`] decodes its XDR as.
#[derive(Clone, Copy, Debug)]
pub enum DecodeTarget<'a> {
    /// A `ScVal` returned by this function.
    Return(&'a str),
    /// A `ScVal` of this user-defined type.
    Type(&'a str),
    /// A `ContractEvent`.
    Event,
}

/// One contract error case a code resolves to (#546).
#[allow(dead_code)] // read by spec_decode_val and simulate (#546).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ErrorCase {
    pub enum_name: String,
    pub name: String,
    pub code: u32,
    pub doc: String,
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

    /// The network configuration `src` holds, as plain JSON for `status`
    /// and `ledger_open` (#535): limits, fee rates and TTLs. A missing
    /// setting is [`LaneError::NetworkConfig`] naming it.
    fn network_config(
        &self,
        src: Rc<dyn ByteSnapshotSource>,
    ) -> Result<serde_json::Value, LaneError>;

    /// Run one `InvokeHostFunction` against `src` in recording mode.
    fn simulate(
        &self,
        request: &SimulateBytes,
        src: Rc<dyn ByteSnapshotSource>,
    ) -> Result<SimulateResultBytes, LaneError>;

    /// The `LedgerKey` XDR of a contract's instance entry.
    #[allow(dead_code)] // the lane's own tests; handlers use `ledger_keys`.
    fn contract_instance_key(&self, contract_id: [u8; 32]) -> Vec<u8>;

    /// Point a CAP-85 executable reference (an owner's `ExecutableTag`
    /// entry) at `wasm_hash`, which every instance sharing it then runs.
    fn retarget_external_ref(
        &self,
        reference_entry_xdr: &[u8],
        wasm_hash: [u8; 32],
    ) -> Result<SwapResultBytes, LaneError>;

    /// Point a contract instance entry at the executable `wasm_hash`, as an
    /// upgrade would, keeping its storage. A CAP-85 instance is repointed at
    /// the WASM directly, leaving its old reference alone.
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

    /// A whole `LedgerEntry` from the pieces RPC's `getLedgerEntries` gives:
    /// `LedgerEntryData` XDR, `lastModifiedLedgerSeq`, and `extXdr`.
    fn assemble_entry(
        &self,
        data_xdr: &[u8],
        last_modified_ledger_seq: u32,
        ext_xdr: Option<&[u8]>,
    ) -> Result<Vec<u8>, LaneError>;

    /// The `HostFunction` XDR that invokes `function` on a contract with
    /// already encoded `ScVal` arguments.
    fn invoke_contract(
        &self,
        contract_id: &str,
        function: &str,
        args_xdr: &[Vec<u8>],
    ) -> Result<Vec<u8>, LaneError>;

    /// The `AccountId` XDR for a `G...` strkey.
    fn account_id(&self, strkey: &str) -> Result<Vec<u8>, LaneError>;

    /// A `SorobanAuthorizationEntry` in plain terms: its credentials, the
    /// address that must sign, the root function it authorizes and how many
    /// sub-invocations it covers (#556, #557).
    fn decode_auth(&self, auth_xdr: &[u8]) -> Result<serde_json::Value, LaneError>;

    /// What a `SorobanTransactionData` says about resources and fee.
    fn transaction_resources(&self, data_xdr: &[u8]) -> Result<TransactionResources, LaneError>;

    /// A `LedgerKey` in words, for messages (`contract data CAS…: Owner("alice")`).
    fn describe_key(&self, key_xdr: &[u8]) -> String;

    /// A `LedgerEntry` in plain terms, for `signet sandbox state` (#554):
    /// contract data by contract, durability, key and value (decoded
    /// without a spec), an instance with its storage map, code by hash.
    fn describe_entry(&self, entry_xdr: &[u8]) -> Result<serde_json::Value, LaneError>;

    /// The contract (C...) whose instance a `LedgerKey` is; `None` for any
    /// other key (#552).
    fn instance_owner(&self, key_xdr: &[u8]) -> Option<String>;

    /// The contract (C...) a contract-data `LedgerKey` belongs to; `None`
    /// for any other key, an account's auth nonce included.
    fn key_contract(&self, key_xdr: &[u8]) -> Option<String>;

    /// Two calls' return values, events, storage writes and auth compared
    /// as exact values (#568): `diff_impl.rs`.
    fn diff_values(
        &self,
        a: &DiffSide,
        b: &DiffSide,
        rules: &DiffRules,
    ) -> Result<serde_json::Value, LaneError>;

    /// Whether the new build can read what the old one stored (#571):
    /// `layout_impl.rs`. `entries` are `(LedgerKey, LedgerEntry)` XDR.
    fn layout_check(
        &self,
        old_wasm: &[u8],
        new_wasm: &[u8],
        entries: &[(Vec<u8>, Vec<u8>)],
        replays: &[LayoutReplay],
    ) -> Result<serde_json::Value, LaneError>;

    /// The call tree in `DiagnosticEvent` XDR (#541).
    fn trace_calls(&self, diagnostic_events_xdr: &[Vec<u8>]) -> Vec<TraceCall>;

    /// The code and instance entries that install `wasm` at `contract_id`,
    /// or at an id derived from the executable's hash.
    fn install(&self, wasm: &[u8], contract_id: Option<&str>) -> Result<Installed, LaneError>;

    /// The ledger write one storage override makes (#559): an entry of the
    /// contract's instance storage, or a persistent or temporary entry,
    /// set or removed. Keys and values are storage expressions, read
    /// against the contract's spec when there is one.
    fn override_storage(&self, req: &StorageOverride) -> Result<StorageWrite, LaneError>;

    /// What a contract instance `LedgerEntry` holds (`contract_info`, #550).
    fn instance_info(&self, entry_xdr: &[u8]) -> Result<InstanceInfo, LaneError>;

    /// The WASM hash an executable-reference entry (an owner's
    /// `ExecutableTag` `LedgerEntry`) holds.
    fn external_ref_wasm_hash(&self, entry_xdr: &[u8]) -> Result<[u8; 32], LaneError>;

    /// The WASM bytes a contract code `LedgerEntry` holds.
    fn code_wasm(&self, entry_xdr: &[u8]) -> Result<Vec<u8>, LaneError>;

    /// The `SpecJson` v1 document for an executable (`spec_extract`, #545):
    /// packages/spec/schema/spec-json.v1.schema.json.
    fn spec_document(&self, wasm: &[u8]) -> Result<serde_json::Value, LaneError>;

    /// Encode a function's JSON arguments (an object by name, or an array in
    /// declaration order) to `ScVal` XDR, one per declared input.
    fn encode_args(
        &self,
        wasm: &[u8],
        function: &str,
        args: &serde_json::Value,
    ) -> Result<Vec<Vec<u8>>, LaneError>;

    /// Decode XDR to JSON with the contract's spec (`spec_decode_val`,
    /// #546): a function's return `ScVal`, a `ScVal` of a named type, or a
    /// `ContractEvent`.
    fn decode(
        &self,
        wasm: &[u8],
        target: DecodeTarget<'_>,
        xdr: &[u8],
    ) -> Result<serde_json::Value, LaneError>;

    /// The error-enum cases a contract error code resolves to; several when
    /// the contract declares more than one error enum (#546).
    fn error_cases(&self, wasm: &[u8], code: u32) -> Result<Vec<ErrorCase>, LaneError>;
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

static BUILTIN: &[&dyn Lane] = &[
    #[cfg(feature = "lane-p28")]
    &p28::LANE,
    #[cfg(feature = "lane-p29")]
    &p29::LANE,
];

impl LaneRegistry {
    pub fn builtin() -> Self {
        Self { lanes: BUILTIN }
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

    #[cfg(feature = "lane-p28")]
    #[test]
    fn protocol_28_resolves_to_the_p28_lane() {
        let lane = LaneRegistry::builtin().for_protocol(28).unwrap();
        assert_eq!(lane.ledger_protocol(), 28);
        assert_eq!(lane.env_host_version(), "28.0.2");
        assert_eq!(lane.simulation_version(), "28.0.2");
    }

    #[cfg(feature = "lane-p29")]
    #[test]
    fn protocol_29_resolves_to_the_p29_lane() {
        let lane = LaneRegistry::builtin().for_protocol(29).unwrap();
        assert_eq!(lane.ledger_protocol(), 29);
        assert_eq!(lane.env_host_version(), "29.0.2");
        assert_eq!(lane.simulation_version(), "29.0.2");
    }

    #[cfg(all(feature = "lane-p28", feature = "lane-p29"))]
    #[test]
    fn protocols_outside_the_window_are_unsupported_and_name_what_is() {
        for requested in [27, 30] {
            let err = LaneRegistry::builtin()
                .for_protocol(requested)
                .err()
                .unwrap();
            assert_eq!(
                err,
                UnsupportedLedgerProtocol {
                    requested,
                    supported: vec![28, 29],
                }
            );
        }
    }

    #[cfg(all(feature = "lane-p28", feature = "lane-p29"))]
    #[test]
    fn the_newest_lane_is_the_default() {
        let registry = LaneRegistry::builtin();
        assert_eq!(registry.newest().ledger_protocol(), 29);
        assert_eq!(registry.supported(), vec![28, 29]);
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

        let forbidden = [
            "soroban_env_host",
            "soroban_simulation",
            "stellar_xdr",
            "soroban_ledger_snapshot",
        ];
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
