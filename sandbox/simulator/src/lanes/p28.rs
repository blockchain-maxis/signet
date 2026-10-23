//! The protocol 28 lane: `soroban-env-host` 28.0.2 and `soroban-simulation`
//! 28.0.2 (sandbox/Cargo.toml). Every versioned type stays inside this file;
//! callers hand it XDR bytes and get XDR bytes back.

use std::io::Cursor;
use std::rc::Rc;

use sha2::{Digest, Sha256};
use soroban_env_host::e2e_invoke::{RecordingInvocationAuthMode, RecordingInvocationAuthParams};
use soroban_env_host::storage::{EntryWithLiveUntil, SnapshotSource};
use soroban_env_host::xdr::{
    AccountId, ContractDataDurability, ContractExecutable, Hash, HostFunction, LedgerEntry,
    LedgerEntryData, LedgerKey, LedgerKeyContractData, Limited, Limits, ReadXdr, ScAddress,
    ScErrorCode, ScErrorType, ScSpecEntry, ScVal, WriteXdr,
};
use soroban_env_host::{HostError, LedgerInfo};
use soroban_simulation::simulation::{
    simulate_invoke_host_function_op, SimulationAdjustmentConfig,
};
use soroban_simulation::NetworkConfig;

use super::{
    ByteSnapshotSource, EntryChangeBytes, Lane, LaneError, SimulateBytes, SimulateResultBytes,
    SwapResultBytes,
};

/// The ledger protocol this lane runs: the pinned host's interface version.
pub const LEDGER_PROTOCOL: u32 = 28;
pub const ENV_HOST_VERSION: &str = "28.0.2";
pub const SIMULATION_VERSION: &str = "28.0.2";

/// Network base reserve, in stroops; not part of the on-ledger Soroban config.
const BASE_RESERVE_STROOPS: u32 = 5_000_000;

/// Custom WASM section that holds the contract spec.
const SPEC_SECTION: &str = "contractspecv0";

pub struct P28Lane;

pub static P28: P28Lane = P28Lane;

fn invalid(what: &'static str) -> LaneError {
    LaneError::InvalidXdr {
        what,
        protocol: LEDGER_PROTOCOL,
    }
}

fn decode<T: ReadXdr>(bytes: &[u8], what: &'static str) -> Result<T, LaneError> {
    T::from_xdr(bytes, Limits::none()).map_err(|_| invalid(what))
}

fn encode<T: WriteXdr>(value: &T, what: &'static str) -> Result<Vec<u8>, LaneError> {
    value.to_xdr(Limits::none()).map_err(|_| invalid(what))
}

fn input_error() -> HostError {
    HostError::from(soroban_env_host::Error::from_type_and_code(
        ScErrorType::Value,
        ScErrorCode::InvalidInput,
    ))
}

/// The host's view of a [`ByteSnapshotSource`]: keys are encoded and entries
/// decoded with this lane's XDR crate on the way through.
struct BytesSnapshot(Rc<dyn ByteSnapshotSource>);

impl SnapshotSource for BytesSnapshot {
    fn get(&self, key: &Rc<LedgerKey>) -> Result<Option<EntryWithLiveUntil>, HostError> {
        let key_xdr = key.to_xdr(Limits::none()).map_err(|_| input_error())?;
        let Some((entry_xdr, live_until)) = self.0.get(&key_xdr) else {
            return Ok(None);
        };
        let entry =
            LedgerEntry::from_xdr(&*entry_xdr, Limits::none()).map_err(|_| input_error())?;
        Ok(Some((Rc::new(entry), live_until)))
    }
}

/// Read one unsigned LEB128 `u32` from `bytes` at `*at`.
fn read_leb_u32(bytes: &[u8], at: &mut usize) -> Result<u32, LaneError> {
    let mut value: u32 = 0;
    for shift in (0..35).step_by(7) {
        let byte = *bytes
            .get(*at)
            .ok_or_else(|| LaneError::InvalidWasm("truncated section header".into()))?;
        *at += 1;
        value |= u32::from(byte & 0x7f)
            .checked_shl(shift)
            .ok_or_else(|| LaneError::InvalidWasm("oversized LEB128".into()))?;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(LaneError::InvalidWasm("oversized LEB128".into()))
}

/// The payloads of every custom section called `name`, in file order.
fn custom_sections<'a>(wasm: &'a [u8], name: &str) -> Result<Vec<&'a [u8]>, LaneError> {
    if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
        return Err(LaneError::InvalidWasm(
            "missing the WASM magic header".into(),
        ));
    }
    let mut at = 8;
    let mut found = Vec::new();
    while at < wasm.len() {
        let id = wasm[at];
        at += 1;
        let size = read_leb_u32(wasm, &mut at)? as usize;
        let end = at
            .checked_add(size)
            .filter(|end| *end <= wasm.len())
            .ok_or_else(|| LaneError::InvalidWasm("section runs past the end".into()))?;
        if id == 0 {
            let mut name_at = at;
            let name_len = read_leb_u32(wasm, &mut name_at)? as usize;
            let name_end = name_at
                .checked_add(name_len)
                .filter(|e| *e <= end)
                .ok_or_else(|| LaneError::InvalidWasm("custom section name runs past it".into()))?;
            if &wasm[name_at..name_end] == name.as_bytes() {
                found.push(&wasm[name_end..end]);
            }
        }
        at = end;
    }
    Ok(found)
}

impl Lane for P28Lane {
    fn ledger_protocol(&self) -> u32 {
        LEDGER_PROTOCOL
    }

    fn env_host_version(&self) -> &'static str {
        ENV_HOST_VERSION
    }

    fn simulation_version(&self) -> &'static str {
        SIMULATION_VERSION
    }

    fn check_ledger_key(&self, key_xdr: &[u8]) -> Result<(), LaneError> {
        decode::<LedgerKey>(key_xdr, "LedgerKey").map(|_| ())
    }

    fn check_ledger_entry(&self, entry_xdr: &[u8]) -> Result<(), LaneError> {
        decode::<LedgerEntry>(entry_xdr, "LedgerEntry").map(|_| ())
    }

    fn simulate(
        &self,
        request: &SimulateBytes,
        src: Rc<dyn ByteSnapshotSource>,
    ) -> Result<SimulateResultBytes, LaneError> {
        let host_fn: HostFunction = decode(&request.host_function_xdr, "HostFunction")?;
        let source_account: AccountId = decode(&request.source_account_xdr, "AccountId")?;

        let snapshot = Rc::new(BytesSnapshot(src));
        let network_config = NetworkConfig::load_from_snapshot(&*snapshot)
            .map_err(|e| LaneError::NetworkConfig(e.to_string()))?;
        let mut ledger_info = LedgerInfo {
            protocol_version: LEDGER_PROTOCOL,
            sequence_number: request.sequence,
            timestamp: request.timestamp,
            network_id: Sha256::digest(request.network_passphrase.as_bytes()).into(),
            base_reserve: BASE_RESERVE_STROOPS,
            ..LedgerInfo::default()
        };
        network_config.fill_config_fields_in_ledger_info(&mut ledger_info);

        let result = simulate_invoke_host_function_op(
            snapshot,
            &network_config,
            &SimulationAdjustmentConfig::no_adjustments(),
            &ledger_info,
            host_fn,
            RecordingInvocationAuthMode::Recording(RecordingInvocationAuthParams::new(true, false)),
            &source_account,
            request.prng_seed,
            request.enable_diagnostics,
        )
        .map_err(|e| LaneError::Simulation(e.to_string()))?;

        let return_value = match &result.invoke_result {
            Ok(value) => Ok(encode(value, "ScVal")?),
            Err(error) => Err(format!("{error:?}")),
        };
        let mut modified_entries = Vec::with_capacity(result.modified_entries.len());
        for diff in &result.modified_entries {
            let Some(entry) = diff.state_after.as_ref().or(diff.state_before.as_ref()) else {
                continue;
            };
            modified_entries.push(EntryChangeBytes {
                key_xdr: encode(&entry.to_key(), "LedgerKey")?,
                entry_xdr: diff
                    .state_after
                    .as_ref()
                    .map(|after| encode(after, "LedgerEntry"))
                    .transpose()?,
            });
        }

        Ok(SimulateResultBytes {
            return_value,
            contract_events_xdr: result
                .contract_events
                .iter()
                .map(|e| encode(e, "ContractEvent"))
                .collect::<Result<_, _>>()?,
            diagnostic_events_xdr: result
                .diagnostic_events
                .iter()
                .map(|e| encode(e, "DiagnosticEvent"))
                .collect::<Result<_, _>>()?,
            auth_xdr: result
                .auth
                .iter()
                .map(|a| encode(a, "SorobanAuthorizationEntry"))
                .collect::<Result<_, _>>()?,
            transaction_data_xdr: result
                .transaction_data
                .as_ref()
                .map(|d| encode(d, "SorobanTransactionData"))
                .transpose()?,
            cpu_instructions: result.simulated_instructions,
            memory_bytes: result.simulated_memory,
            modified_entries,
        })
    }

    fn contract_instance_key(&self, contract_id: [u8; 32]) -> Vec<u8> {
        LedgerKey::ContractData(LedgerKeyContractData {
            contract: ScAddress::Contract(Hash(contract_id).into()),
            key: ScVal::LedgerKeyContractInstance,
            durability: ContractDataDurability::Persistent,
        })
        .to_xdr(Limits::none())
        .expect("a contract instance key always encodes")
    }

    fn swap(
        &self,
        instance_entry_xdr: &[u8],
        wasm_hash: [u8; 32],
    ) -> Result<SwapResultBytes, LaneError> {
        let mut entry: LedgerEntry = decode(instance_entry_xdr, "LedgerEntry")?;
        let LedgerEntryData::ContractData(data) = &mut entry.data else {
            return Err(LaneError::NotAContractInstance);
        };
        if data.key != ScVal::LedgerKeyContractInstance {
            return Err(LaneError::NotAContractInstance);
        }
        let ScVal::ContractInstance(instance) = &mut data.val else {
            return Err(LaneError::NotAContractInstance);
        };
        let ContractExecutable::Wasm(Hash(previous)) = instance.executable else {
            return Err(LaneError::NotAContractInstance);
        };
        instance.executable = ContractExecutable::Wasm(Hash(wasm_hash));
        Ok(SwapResultBytes {
            entry_xdr: encode(&entry, "LedgerEntry")?,
            previous_wasm_hash: previous,
        })
    }

    fn spec_entries(&self, wasm: &[u8]) -> Result<Vec<Vec<u8>>, LaneError> {
        let mut entries = Vec::new();
        for payload in custom_sections(wasm, SPEC_SECTION)? {
            let mut reader = Limited::new(Cursor::new(payload), Limits::none());
            for entry in ScSpecEntry::read_xdr_iter(&mut reader) {
                let entry =
                    entry.map_err(|e| LaneError::InvalidWasm(format!("{SPEC_SECTION}: {e}")))?;
                entries.push(encode(&entry, "ScSpecEntry")?);
            }
        }
        Ok(entries)
    }
}

/// XDR fixtures for tests outside `lanes/`, which may not name a versioned type.
#[cfg(test)]
pub mod fixtures {
    use super::*;
    use soroban_env_host::xdr::{ContractDataEntry, ExtensionPoint, LedgerEntryExt};

    fn contract() -> ScAddress {
        ScAddress::Contract(Hash([7u8; 32]).into())
    }

    /// A distinct persistent contract-data `LedgerKey` per `n`.
    pub fn data_key_xdr(n: u32) -> Vec<u8> {
        LedgerKey::ContractData(LedgerKeyContractData {
            contract: contract(),
            key: ScVal::U32(n),
            durability: ContractDataDurability::Persistent,
        })
        .to_xdr(Limits::none())
        .unwrap()
    }

    /// The contract-data `LedgerEntry` for key `n` holding `v`.
    pub fn data_entry_xdr(n: u32, v: u32) -> Vec<u8> {
        LedgerEntry {
            last_modified_ledger_seq: 0,
            data: LedgerEntryData::ContractData(ContractDataEntry {
                ext: ExtensionPoint::V0,
                contract: contract(),
                key: ScVal::U32(n),
                durability: ContractDataDurability::Persistent,
                val: ScVal::U32(v),
            }),
            ext: LedgerEntryExt::V0,
        }
        .to_xdr(Limits::none())
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_env_host::xdr::{
        ContractDataEntry, ExtensionPoint, InvokeContractArgs, LedgerEntryExt, PublicKey,
        ScContractInstance, ScSpecFunctionV0, ScSymbol, StringM, Uint256,
    };
    use std::collections::HashMap;

    /// A stored entry's XDR and its `live_until` ledger.
    type StoredEntry = (Rc<[u8]>, Option<u32>);

    /// An in-memory byte ledger, standing in for the layered store.
    #[derive(Default)]
    struct Ledger(HashMap<Vec<u8>, StoredEntry>);

    impl ByteSnapshotSource for Ledger {
        fn get(&self, key_xdr: &[u8]) -> Option<StoredEntry> {
            self.0.get(key_xdr).cloned()
        }
    }

    fn instance_entry(contract_id: [u8; 32], wasm: [u8; 32]) -> LedgerEntry {
        LedgerEntry {
            last_modified_ledger_seq: 0,
            data: LedgerEntryData::ContractData(ContractDataEntry {
                ext: ExtensionPoint::V0,
                contract: ScAddress::Contract(Hash(contract_id).into()),
                key: ScVal::LedgerKeyContractInstance,
                durability: ContractDataDurability::Persistent,
                val: ScVal::ContractInstance(ScContractInstance {
                    executable: ContractExecutable::Wasm(Hash(wasm)),
                    storage: None,
                }),
            }),
            ext: LedgerEntryExt::V0,
        }
    }

    fn request(host_function_xdr: Vec<u8>) -> SimulateBytes {
        SimulateBytes {
            network_passphrase: "Test SDF Network ; September 2015".to_string(),
            sequence: 100,
            timestamp: 1_700_000_000,
            host_function_xdr,
            source_account_xdr: AccountId(PublicKey::PublicKeyTypeEd25519(Uint256([1; 32])))
                .to_xdr(Limits::none())
                .unwrap(),
            prng_seed: [0; 32],
            enable_diagnostics: false,
        }
    }

    fn invoke_xdr() -> Vec<u8> {
        HostFunction::InvokeContract(InvokeContractArgs {
            contract_address: ScAddress::Contract(Hash([9; 32]).into()),
            function_name: ScSymbol("hello".try_into().unwrap()),
            args: Default::default(),
        })
        .to_xdr(Limits::none())
        .unwrap()
    }

    #[test]
    fn key_and_entry_checks_accept_valid_xdr_and_name_the_type_otherwise() {
        assert!(P28.check_ledger_key(&fixtures::data_key_xdr(1)).is_ok());
        assert!(P28
            .check_ledger_entry(&fixtures::data_entry_xdr(1, 2))
            .is_ok());
        assert_eq!(
            P28.check_ledger_key(b"junk"),
            Err(LaneError::InvalidXdr {
                what: "LedgerKey",
                protocol: 28
            })
        );
        // An entry is not a key.
        assert!(P28
            .check_ledger_key(&fixtures::data_entry_xdr(1, 2))
            .is_err());
    }

    #[test]
    fn the_snapshot_adapter_decodes_bytes_and_passes_expiry_through() {
        let mut ledger = Ledger::default();
        ledger.0.insert(
            fixtures::data_key_xdr(1),
            (fixtures::data_entry_xdr(1, 42).into(), Some(500)),
        );
        let snapshot = BytesSnapshot(Rc::new(ledger));

        let key = Rc::new(LedgerKey::from_xdr(fixtures::data_key_xdr(1), Limits::none()).unwrap());
        let (entry, live_until) = snapshot.get(&key).unwrap().unwrap();
        assert_eq!(live_until, Some(500));
        let LedgerEntryData::ContractData(data) = &entry.data else {
            panic!("expected contract data");
        };
        assert_eq!(data.val, ScVal::U32(42));

        let missing =
            Rc::new(LedgerKey::from_xdr(fixtures::data_key_xdr(2), Limits::none()).unwrap());
        assert!(snapshot.get(&missing).unwrap().is_none());
    }

    #[test]
    fn simulate_rejects_bytes_that_are_not_a_host_function() {
        let err = P28
            .simulate(&request(b"junk".to_vec()), Rc::new(Ledger::default()))
            .unwrap_err();
        assert_eq!(
            err,
            LaneError::InvalidXdr {
                what: "HostFunction",
                protocol: 28
            }
        );
    }

    #[test]
    fn simulate_needs_the_network_config_entries_from_the_fork() {
        // A well-formed call against a ledger with no ConfigSetting entries:
        // the lane reads the ledger through the byte source and says what is
        // missing instead of guessing fees and limits.
        let err = P28
            .simulate(&request(invoke_xdr()), Rc::new(Ledger::default()))
            .unwrap_err();
        assert!(matches!(err, LaneError::NetworkConfig(_)), "{err:?}");
    }

    #[test]
    fn swap_points_the_instance_at_the_new_executable() {
        let entry = instance_entry([3; 32], [1; 32])
            .to_xdr(Limits::none())
            .unwrap();

        let swapped = P28.swap(&entry, [2; 32]).unwrap();

        assert_eq!(swapped.previous_wasm_hash, [1; 32]);
        let after = LedgerEntry::from_xdr(swapped.entry_xdr, Limits::none()).unwrap();
        assert_eq!(after, instance_entry([3; 32], [2; 32]));
    }

    #[test]
    fn swap_refuses_anything_but_a_wasm_contract_instance() {
        assert_eq!(
            P28.swap(&fixtures::data_entry_xdr(1, 1), [2; 32]),
            Err(LaneError::NotAContractInstance)
        );
        assert!(matches!(
            P28.swap(b"junk", [2; 32]),
            Err(LaneError::InvalidXdr { .. })
        ));
    }

    #[test]
    fn the_instance_key_matches_the_instance_entry() {
        let entry = instance_entry([5; 32], [1; 32]);
        assert_eq!(
            P28.contract_instance_key([5; 32]),
            entry.to_key().to_xdr(Limits::none()).unwrap()
        );
    }

    fn leb(mut n: usize) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (n & 0x7f) as u8;
            n >>= 7;
            if n == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }

    /// A minimal module: header plus one custom section per `(name, payload)`.
    fn wasm_with(sections: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        for (name, payload) in sections {
            let mut body = leb(name.len());
            body.extend_from_slice(name.as_bytes());
            body.extend_from_slice(payload);
            wasm.push(0);
            wasm.extend(leb(body.len()));
            wasm.extend(body);
        }
        wasm
    }

    fn function_spec(name: &str) -> ScSpecEntry {
        ScSpecEntry::FunctionV0(ScSpecFunctionV0 {
            doc: StringM::default(),
            name: ScSymbol(name.try_into().unwrap()),
            inputs: Default::default(),
            outputs: Default::default(),
        })
    }

    #[test]
    fn spec_entries_come_out_of_the_contractspecv0_section_in_order() {
        let mut payload = function_spec("hello").to_xdr(Limits::none()).unwrap();
        payload.extend(function_spec("world").to_xdr(Limits::none()).unwrap());
        let wasm = wasm_with(&[("other", vec![1, 2, 3]), (SPEC_SECTION, payload)]);

        let entries = P28.spec_entries(&wasm).unwrap();

        let names: Vec<String> = entries
            .iter()
            .map(
                |bytes| match ScSpecEntry::from_xdr(bytes, Limits::none()).unwrap() {
                    ScSpecEntry::FunctionV0(f) => f.name.0.to_utf8_string_lossy(),
                    other => panic!("unexpected {other:?}"),
                },
            )
            .collect();
        assert_eq!(names, ["hello", "world"]);
    }

    #[test]
    fn a_module_without_a_spec_has_no_entries_and_junk_is_rejected() {
        assert!(P28.spec_entries(&wasm_with(&[])).unwrap().is_empty());
        assert!(matches!(
            P28.spec_entries(b"not wasm"),
            Err(LaneError::InvalidWasm(_))
        ));
        assert!(matches!(
            P28.spec_entries(&wasm_with(&[(SPEC_SECTION, vec![0xff; 3])])),
            Err(LaneError::InvalidWasm(_))
        ));
    }
}
