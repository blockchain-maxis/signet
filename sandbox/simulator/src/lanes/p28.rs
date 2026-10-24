//! The protocol 28 lane: `soroban-env-host` 28.0.2 and `soroban-simulation`
//! 28.0.2 (sandbox/Cargo.toml). Every versioned type stays inside this file;
//! callers hand it XDR bytes and get XDR bytes back.

use std::io::Cursor;
use std::rc::Rc;
use std::str::FromStr;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use soroban_env_host::e2e_invoke::{RecordingInvocationAuthMode, RecordingInvocationAuthParams};
use soroban_env_host::storage::{EntryWithLiveUntil, SnapshotSource};
use soroban_env_host::xdr::{
    AccountId, ConfigSettingId, ContractCodeEntry, ContractCodeEntryExt, ContractDataDurability,
    ContractDataEntry, ContractEvent, ContractEventBody, ContractExecutable, ContractId,
    ExtensionPoint, FeeBumpTransactionInnerTx, Hash, HostFunction, InvokeContractArgs, LedgerEntry,
    LedgerEntryData, LedgerEntryExt, LedgerKey, LedgerKeyAccount, LedgerKeyConfigSetting,
    LedgerKeyContractCode, LedgerKeyContractData, Limited, Limits, MuxedAccount, OperationBody,
    ReadXdr, ScAddress, ScContractInstance, ScEnvMetaEntry, ScError, ScErrorCode, ScErrorType,
    ScSpecEntry, ScSymbol, ScVal, SorobanAuthorizationEntry, SorobanAuthorizedFunction,
    SorobanCredentials, SorobanTransactionData, StringM, TransactionEnvelope, TransactionMeta,
    WriteXdr,
};
use soroban_env_host::{HostError, LedgerInfo};
use soroban_simulation::simulation::{
    simulate_invoke_host_function_op, SimulationAdjustmentConfig,
};
use soroban_simulation::NetworkConfig;

use super::{
    ByteSnapshotSource, DecodeTarget, DerivedKey, EntryChangeBytes, ErrorCase, ExternalRef,
    Installed, InstanceInfo, InterfaceVersion, InvocationFailure, KeyRequest, Lane, LaneError,
    SimulateBytes, SimulateResultBytes, SwapResultBytes, TransactionResources, WasmInspection,
};

/// The ledger protocol this lane runs: the pinned host's interface version.
pub const LEDGER_PROTOCOL: u32 = 28;
pub const ENV_HOST_VERSION: &str = "28.0.2";
pub const SIMULATION_VERSION: &str = "28.0.2";

/// Custom WASM section that holds the contract spec.
const SPEC_SECTION: &str = "contractspecv0";

mod spec;

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
        // A source that gave up keeps its reason; the host just has to stop.
        let found = self.0.get(&key_xdr).map_err(|_| {
            HostError::from(soroban_env_host::Error::from_type_and_code(
                ScErrorType::Storage,
                ScErrorCode::MissingValue,
            ))
        })?;
        let Some((entry_xdr, live_until)) = found else {
            return Ok(None);
        };
        let entry =
            LedgerEntry::from_xdr(&*entry_xdr, Limits::none()).map_err(|_| input_error())?;
        Ok(Some((Rc::new(entry), live_until)))
    }
}

/// How an invocation failed, in the host's terms.
fn invocation_failure(error: &HostError) -> InvocationFailure {
    let detail = format!("{:?}", error.error);
    match ScError::try_from(error.error) {
        Ok(sc) => {
            let (error_type, error_code) = spec::host_error_parts(&sc);
            InvocationFailure {
                contract_code: match sc {
                    ScError::Contract(code) => Some(code),
                    _ => None,
                },
                error_type,
                error_code,
                detail,
            }
        }
        Err(_) => InvocationFailure {
            contract_code: None,
            error_type: "Unknown".into(),
            error_code: "Unknown".into(),
            detail,
        },
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
    let mut found = Vec::new();
    for (id, payload) in wasm_sections(wasm)? {
        if id != SECTION_CUSTOM {
            continue;
        }
        let mut at = 0;
        if read_name(payload, &mut at)? == name {
            found.push(&payload[at..]);
        }
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

    fn network_config(&self, src: Rc<dyn ByteSnapshotSource>) -> Result<Value, LaneError> {
        let snapshot = BytesSnapshot(src);
        let config = NetworkConfig::load_from_snapshot(&snapshot)
            .map_err(|e| LaneError::NetworkConfig(e.to_string()))?;
        let fees = &config.fee_configuration;
        let rent = &config.rent_fee_configuration;
        Ok(json!({
            "tx_max_instructions": config.tx_max_instructions,
            "tx_memory_limit": config.tx_memory_limit,
            "min_temporary_ttl": config.min_temp_entry_ttl,
            "min_persistent_ttl": config.min_persistent_entry_ttl,
            "max_entry_ttl": config.max_entry_ttl,
            "fee_per_instruction_increment": fees.fee_per_instruction_increment,
            "fee_per_disk_read_entry": fees.fee_per_disk_read_entry,
            "fee_per_write_entry": fees.fee_per_write_entry,
            "fee_per_disk_read_1kb": fees.fee_per_disk_read_1kb,
            "fee_per_write_1kb": fees.fee_per_write_1kb,
            "fee_per_historical_1kb": fees.fee_per_historical_1kb,
            "fee_per_contract_event_1kb": fees.fee_per_contract_event_1kb,
            "fee_per_transaction_size_1kb": fees.fee_per_transaction_size_1kb,
            "fee_per_rent_1kb": rent.fee_per_rent_1kb,
            "persistent_rent_rate_denominator": rent.persistent_rent_rate_denominator,
            "temporary_rent_rate_denominator": rent.temporary_rent_rate_denominator,
        }))
    }

    fn simulate(
        &self,
        request: &SimulateBytes,
        src: Rc<dyn ByteSnapshotSource>,
    ) -> Result<SimulateResultBytes, LaneError> {
        let host_fn: HostFunction = decode(&request.host_function_xdr, "HostFunction")?;
        let source_account: AccountId = decode(&request.source_account_xdr, "AccountId")?;

        let snapshot = Rc::new(BytesSnapshot(src.clone()));
        let network_config = NetworkConfig::load_from_snapshot(&*snapshot)
            .map_err(|e| LaneError::NetworkConfig(e.to_string()))?;
        let mut ledger_info = LedgerInfo {
            protocol_version: LEDGER_PROTOCOL,
            sequence_number: request.sequence,
            timestamp: request.timestamp,
            network_id: Sha256::digest(request.network_passphrase.as_bytes()).into(),
            base_reserve: request.base_reserve,
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
            Err(error) => Err(invocation_failure(error)),
        };
        let mut modified_entries = Vec::with_capacity(result.modified_entries.len());
        for diff in &result.modified_entries {
            let Some(entry) = diff.state_after.as_ref().or(diff.state_before.as_ref()) else {
                continue;
            };
            let key = entry.to_key();
            let key_xdr = encode(&key, "LedgerKey")?;
            // The diff carries no TTL: an entry that existed keeps its own,
            // a new one gets the network's minimum for its durability.
            let previous_ttl = src
                .get(&key_xdr)
                .ok()
                .flatten()
                .and_then(|(_, live_until)| live_until);
            let live_until = match (&diff.state_before, previous_ttl) {
                (Some(_), Some(ttl)) => Some(ttl),
                _ => match &key {
                    LedgerKey::ContractData(data)
                        if data.durability == ContractDataDurability::Temporary =>
                    {
                        Some(
                            request
                                .sequence
                                .saturating_add(ledger_info.min_temp_entry_ttl - 1),
                        )
                    }
                    LedgerKey::ContractData(_) | LedgerKey::ContractCode(_) => Some(
                        request
                            .sequence
                            .saturating_add(ledger_info.min_persistent_entry_ttl - 1),
                    ),
                    _ => None,
                },
            };
            modified_entries.push(EntryChangeBytes {
                key_xdr,
                before_xdr: diff
                    .state_before
                    .as_ref()
                    .map(|before| encode(before, "LedgerEntry"))
                    .transpose()?,
                entry_xdr: diff
                    .state_after
                    .as_ref()
                    .map(|after| encode(after, "LedgerEntry"))
                    .transpose()?,
                live_until,
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

    fn ledger_keys(&self, request: &KeyRequest) -> Result<Vec<DerivedKey>, LaneError> {
        let key = |kind: &'static str,
                   subject: String,
                   key: LedgerKey|
         -> Result<DerivedKey, LaneError> {
            Ok(DerivedKey {
                kind,
                subject,
                key_xdr: encode(&key, "LedgerKey")?,
            })
        };
        Ok(match request {
            KeyRequest::ContractInstance { contract_id } => {
                let ScAddress::Contract(ContractId(Hash(id))) = contract_address(contract_id)?
                else {
                    unreachable!("contract_address only returns contracts")
                };
                vec![DerivedKey {
                    kind: "contract_instance",
                    subject: contract_id.clone(),
                    key_xdr: self.contract_instance_key(id),
                }]
            }
            KeyRequest::ContractCode { wasm_hash } => vec![key(
                "contract_code",
                hex(wasm_hash),
                LedgerKey::ContractCode(LedgerKeyContractCode {
                    hash: Hash(*wasm_hash),
                }),
            )?],
            KeyRequest::Account { account_id } => {
                let parsed =
                    AccountId::from_str(account_id).map_err(|e| LaneError::InvalidInput {
                        what: "account id",
                        detail: e.to_string(),
                    })?;
                vec![key(
                    "account",
                    account_id.clone(),
                    LedgerKey::Account(LedgerKeyAccount { account_id: parsed }),
                )?]
            }
            KeyRequest::ConfigSetting { setting } => {
                let id = ConfigSettingId::VARIANTS
                    .iter()
                    .copied()
                    .find(|id| id.name() == setting)
                    .ok_or_else(|| LaneError::InvalidInput {
                        what: "config setting",
                        detail: format!("no ConfigSettingId named `{setting}`"),
                    })?;
                vec![config_setting_key(id)?]
            }
            KeyRequest::NetworkConfig => NETWORK_CONFIG_SETTINGS
                .iter()
                .map(|id| config_setting_key(*id))
                .collect::<Result<_, _>>()?,
        })
    }

    fn decode_transaction(
        &self,
        envelope_xdr: &[u8],
        meta_xdr: Option<&[u8]>,
    ) -> Result<serde_json::Value, LaneError> {
        let envelope: TransactionEnvelope = decode(envelope_xdr, "TransactionEnvelope")?;
        let meta = meta_xdr
            .map(|bytes| decode::<TransactionMeta>(bytes, "TransactionMeta"))
            .transpose()?;

        // A fee bump only changes who pays; what ran is the inner transaction.
        let (fee_bump, source, operations) = match &envelope {
            TransactionEnvelope::TxV0(v0) => (
                false,
                MuxedAccount::Ed25519(v0.tx.source_account_ed25519.clone()),
                &v0.tx.operations,
            ),
            TransactionEnvelope::Tx(v1) => (false, v1.tx.source_account.clone(), &v1.tx.operations),
            TransactionEnvelope::TxFeeBump(bump) => {
                let FeeBumpTransactionInnerTx::Tx(inner) = &bump.tx.inner_tx;
                (true, inner.tx.source_account.clone(), &inner.tx.operations)
            }
        };

        let mut out = json!({
            "source_account": source.to_string(),
            "fee_bump": fee_bump,
            "operation_count": operations.len(),
        });
        // A Soroban transaction carries exactly one operation.
        let invoke = match operations.as_slice() {
            [op] => match &op.body {
                OperationBody::InvokeHostFunction(invoke) => Some((op, invoke)),
                _ => None,
            },
            _ => None,
        };
        match invoke {
            None => {
                out["host_function"] = json!({
                    "kind": null,
                    "replayable": false,
                    "reason": "not a Soroban transaction: it needs exactly one InvokeHostFunction operation",
                });
                out["auth"] = json!([]);
            }
            Some((op, invoke)) => {
                if let Some(op_source) = &op.source_account {
                    out["operation_source_account"] = json!(op_source.to_string());
                }
                out["host_function"] = host_function_json(&invoke.host_function)?;
                out["auth"] = invoke
                    .auth
                    .iter()
                    .map(auth_json)
                    .collect::<Result<Vec<_>, _>>()?
                    .into();
            }
        }
        if let Some(meta) = &meta {
            out["result"] = meta_json(meta)?;
        }
        Ok(out)
    }

    fn inspect_wasm(&self, wasm: &[u8]) -> Result<WasmInspection, LaneError> {
        let sections = wasm_sections(wasm)?;
        let mut custom_sections = Vec::new();
        let mut env_meta = Vec::new();
        let mut exports = Vec::new();
        let mut imports = Vec::new();
        for (id, payload) in sections {
            match id {
                SECTION_CUSTOM => {
                    let mut at = 0;
                    let name = read_name(payload, &mut at)?;
                    if name == ENV_META_SECTION {
                        env_meta.push(&payload[at..]);
                    }
                    custom_sections.push(name);
                }
                SECTION_IMPORT => imports = read_imports(payload)?,
                SECTION_EXPORT => exports = read_function_exports(payload)?,
                _ => {}
            }
        }

        let mut interface_version = None;
        for payload in env_meta {
            let mut reader = Limited::new(Cursor::new(payload), Limits::none());
            for entry in ScEnvMetaEntry::read_xdr_iter(&mut reader) {
                let entry = entry
                    .map_err(|e| LaneError::InvalidWasm(format!("{ENV_META_SECTION}: {e}")))?;
                let ScEnvMetaEntry::ScEnvMetaKindInterfaceVersion(version) = entry;
                interface_version = Some(InterfaceVersion {
                    protocol: version.protocol,
                    pre_release: version.pre_release,
                });
            }
        }

        Ok(WasmInspection {
            wasm_hash: Sha256::digest(wasm).into(),
            size_bytes: wasm.len(),
            custom_sections,
            interface_version,
            exports,
            imports,
        })
    }

    fn assemble_entry(
        &self,
        data_xdr: &[u8],
        last_modified_ledger_seq: u32,
        ext_xdr: Option<&[u8]>,
    ) -> Result<Vec<u8>, LaneError> {
        let data: LedgerEntryData = decode(data_xdr, "LedgerEntryData")?;
        let ext = match ext_xdr {
            Some(bytes) => decode(bytes, "LedgerEntryExt")?,
            None => LedgerEntryExt::V0,
        };
        encode(
            &LedgerEntry {
                last_modified_ledger_seq,
                data,
                ext,
            },
            "LedgerEntry",
        )
    }

    fn invoke_contract(
        &self,
        contract_id: &str,
        function: &str,
        args_xdr: &[Vec<u8>],
    ) -> Result<Vec<u8>, LaneError> {
        let args: Vec<ScVal> = args_xdr
            .iter()
            .map(|a| decode(a, "ScVal"))
            .collect::<Result<_, _>>()?;
        let function_name = ScSymbol(StringM::try_from(function.as_bytes().to_vec()).map_err(
            |_| LaneError::InvalidInput {
                what: "function",
                detail: "a function name is at most 32 characters".into(),
            },
        )?);
        encode(
            &HostFunction::InvokeContract(InvokeContractArgs {
                contract_address: contract_address(contract_id)?,
                function_name,
                args: args.try_into().map_err(|_| invalid("ScVal arguments"))?,
            }),
            "HostFunction",
        )
    }

    fn account_id(&self, strkey: &str) -> Result<Vec<u8>, LaneError> {
        let account = AccountId::from_str(strkey).map_err(|e| LaneError::InvalidInput {
            what: "account id",
            detail: e.to_string(),
        })?;
        encode(&account, "AccountId")
    }

    fn transaction_resources(&self, data_xdr: &[u8]) -> Result<TransactionResources, LaneError> {
        let data: SorobanTransactionData = decode(data_xdr, "SorobanTransactionData")?;
        let keys = |keys: &[LedgerKey]| -> Result<Vec<Vec<u8>>, LaneError> {
            keys.iter().map(|k| encode(k, "LedgerKey")).collect()
        };
        Ok(TransactionResources {
            instructions: data.resources.instructions,
            disk_read_bytes: data.resources.disk_read_bytes,
            write_bytes: data.resources.write_bytes,
            read_only: keys(&data.resources.footprint.read_only)?,
            read_write: keys(&data.resources.footprint.read_write)?,
            resource_fee: data.resource_fee,
        })
    }

    fn describe_key(&self, key_xdr: &[u8]) -> String {
        let Ok(key) = decode::<LedgerKey>(key_xdr, "LedgerKey") else {
            return "an undecodable ledger key".into();
        };
        match &key {
            LedgerKey::ContractData(data) => {
                let value = spec::generic(&data.key)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| data.key.name().to_string());
                let what = if data.key == ScVal::LedgerKeyContractInstance {
                    "instance".to_string()
                } else {
                    format!("{} data {value}", data.durability.name().to_lowercase())
                };
                format!("{} {what}", data.contract)
            }
            LedgerKey::ContractCode(code) => format!("contract code {}", hex(&code.hash.0)),
            LedgerKey::Account(account) => format!("account {}", account.account_id),
            LedgerKey::ConfigSetting(setting) => {
                format!("config setting {}", setting.config_setting_id.name())
            }
            other => other.name().to_string(),
        }
    }

    fn install(&self, wasm: &[u8], contract_id: Option<&str>) -> Result<Installed, LaneError> {
        if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
            return Err(LaneError::InvalidWasm(
                "missing the WASM magic header".into(),
            ));
        }
        let wasm_hash: [u8; 32] = Sha256::digest(wasm).into();
        let address = match contract_id {
            Some(id) => contract_address(id)?,
            // A stable id per executable, so installing the same WASM twice
            // in a session addresses the same contract.
            None => {
                let mut seed = Sha256::new();
                seed.update(b"signet-sandbox-install");
                seed.update(wasm_hash);
                ScAddress::Contract(ContractId(Hash(seed.finalize().into())))
            }
        };
        let ScAddress::Contract(ContractId(Hash(id))) = &address else {
            unreachable!("contract_address only returns contracts")
        };
        let code_key = LedgerKey::ContractCode(LedgerKeyContractCode {
            hash: Hash(wasm_hash),
        });
        let code = LedgerEntry {
            last_modified_ledger_seq: 0,
            data: LedgerEntryData::ContractCode(ContractCodeEntry {
                ext: ContractCodeEntryExt::V0,
                hash: Hash(wasm_hash),
                code: wasm
                    .to_vec()
                    .try_into()
                    .map_err(|_| invalid("ContractCode"))?,
            }),
            ext: LedgerEntryExt::V0,
        };
        let instance = LedgerEntry {
            last_modified_ledger_seq: 0,
            data: LedgerEntryData::ContractData(ContractDataEntry {
                ext: ExtensionPoint::V0,
                contract: address.clone(),
                key: ScVal::LedgerKeyContractInstance,
                durability: ContractDataDurability::Persistent,
                val: ScVal::ContractInstance(ScContractInstance {
                    executable: ContractExecutable::Wasm(Hash(wasm_hash)),
                    storage: None,
                }),
            }),
            ext: LedgerEntryExt::V0,
        };
        Ok(Installed {
            contract_id: address.to_string(),
            wasm_hash,
            entries: vec![
                (
                    encode(&code_key, "LedgerKey")?,
                    encode(&code, "LedgerEntry")?,
                ),
                (
                    self.contract_instance_key(*id),
                    encode(&instance, "LedgerEntry")?,
                ),
            ],
        })
    }

    fn instance_info(&self, entry_xdr: &[u8]) -> Result<InstanceInfo, LaneError> {
        let entry: LedgerEntry = decode(entry_xdr, "LedgerEntry")?;
        let LedgerEntryData::ContractData(data) = &entry.data else {
            return Err(LaneError::NotAContractInstance);
        };
        let ScVal::ContractInstance(instance) = &data.val else {
            return Err(LaneError::NotAContractInstance);
        };
        let (executable, wasm_hash, external_ref) = match &instance.executable {
            ContractExecutable::Wasm(Hash(hash)) => ("wasm", Some(*hash), None),
            ContractExecutable::StellarAsset => ("stellar_asset", None, None),
            // CAP-85: the owner keeps the WASM hash in a persistent entry
            // keyed by the tag, the key the host itself resolves.
            ContractExecutable::ExternalRef(external) => {
                let key = LedgerKey::ContractData(LedgerKeyContractData {
                    contract: external.executable_owner.clone(),
                    key: ScVal::ExecutableTag(external.tag.clone()),
                    durability: ContractDataDurability::Persistent,
                });
                (
                    "external_ref",
                    None,
                    Some(ExternalRef {
                        owner: external.executable_owner.to_string(),
                        tag: external.tag.to_utf8_string_lossy(),
                        key_xdr: encode(&key, "LedgerKey")?,
                    }),
                )
            }
        };
        Ok(InstanceInfo {
            executable,
            wasm_hash,
            external_ref,
            storage_entries: instance.storage.as_ref().map_or(0, |m| m.len()),
        })
    }

    fn external_ref_wasm_hash(&self, entry_xdr: &[u8]) -> Result<[u8; 32], LaneError> {
        let entry: LedgerEntry = decode(entry_xdr, "LedgerEntry")?;
        let LedgerEntryData::ContractData(data) = &entry.data else {
            return Err(invalid("executable reference entry"));
        };
        match &data.val {
            ScVal::Bytes(bytes) => bytes
                .as_slice()
                .try_into()
                .map_err(|_| invalid("32-byte WASM hash")),
            _ => Err(invalid("executable reference entry holding a WASM hash")),
        }
    }

    fn code_wasm(&self, entry_xdr: &[u8]) -> Result<Vec<u8>, LaneError> {
        let entry: LedgerEntry = decode(entry_xdr, "LedgerEntry")?;
        match entry.data {
            LedgerEntryData::ContractCode(code) => Ok(code.code.to_vec()),
            _ => Err(invalid("ContractCode LedgerEntry")),
        }
    }

    fn spec_document(&self, wasm: &[u8]) -> Result<Value, LaneError> {
        spec::spec_json(wasm)
    }

    fn encode_args(
        &self,
        wasm: &[u8],
        function: &str,
        args: &Value,
    ) -> Result<Vec<Vec<u8>>, LaneError> {
        let spec = spec::Spec::from_wasm(wasm)?;
        spec.encode_args(function, args)?
            .iter()
            .map(|v| encode(v, "ScVal"))
            .collect()
    }

    fn decode(
        &self,
        wasm: &[u8],
        target: DecodeTarget<'_>,
        xdr: &[u8],
    ) -> Result<Value, LaneError> {
        let spec = spec::Spec::from_wasm(wasm)?;
        match target {
            DecodeTarget::Return(function) => spec.decode_return(function, &decode(xdr, "ScVal")?),
            DecodeTarget::Type(name) => spec.decode_as(name, &decode(xdr, "ScVal")?),
            DecodeTarget::Event => spec.decode_event(&decode(xdr, "ContractEvent")?),
        }
    }

    fn error_cases(&self, wasm: &[u8], code: u32) -> Result<Vec<ErrorCase>, LaneError> {
        let spec = spec::Spec::from_wasm(wasm)?;
        Ok(spec
            .error_cases(code)
            .into_iter()
            .map(|(enum_name, name, doc)| ErrorCase {
                enum_name,
                name,
                code,
                doc,
            })
            .collect())
    }
}

// ─── XDR helpers (#532) ────────────────────────────────────────────────────────

/// Custom WASM section that holds the environment meta (interface version).
const ENV_META_SECTION: &str = "contractenvmetav0";

/// WASM section ids `inspect_wasm` reads.
const SECTION_CUSTOM: u8 = 0;
const SECTION_IMPORT: u8 = 2;
const SECTION_EXPORT: u8 = 7;

/// The `ConfigSetting` entries `NetworkConfig::load_from_snapshot` reads, in
/// the order it reads them (soroban-simulation 28.0.2, `network_config.rs`).
/// A fork that fetches exactly these can build the lane's `NetworkConfig`.
const NETWORK_CONFIG_SETTINGS: [ConfigSettingId; 10] = [
    ConfigSettingId::ContractComputeV0,
    ConfigSettingId::ContractLedgerCostV0,
    ConfigSettingId::ContractLedgerCostExtV0,
    ConfigSettingId::ContractHistoricalDataV0,
    ConfigSettingId::ContractEventsV0,
    ConfigSettingId::ContractBandwidthV0,
    ConfigSettingId::StateArchival,
    ConfigSettingId::ContractCostParamsCpuInstructions,
    ConfigSettingId::ContractCostParamsMemoryBytes,
    ConfigSettingId::LiveSorobanStateSizeWindow,
];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/// A `C...` strkey as an `ScAddress::Contract`.
fn contract_address(strkey: &str) -> Result<ScAddress, LaneError> {
    let invalid = |detail: String| LaneError::InvalidInput {
        what: "contract id",
        detail,
    };
    match ScAddress::from_str(strkey) {
        Ok(address @ ScAddress::Contract(_)) => Ok(address),
        Ok(_) => Err(invalid("not a contract strkey (C...)".into())),
        Err(e) => Err(invalid(e.to_string())),
    }
}

fn config_setting_key(id: ConfigSettingId) -> Result<DerivedKey, LaneError> {
    Ok(DerivedKey {
        kind: "config_setting",
        subject: id.name().to_string(),
        key_xdr: encode(
            &LedgerKey::ConfigSetting(LedgerKeyConfigSetting {
                config_setting_id: id,
            }),
            "LedgerKey",
        )?,
    })
}

/// Every section of a module as `(id, payload)`, in file order.
fn wasm_sections(wasm: &[u8]) -> Result<Vec<(u8, &[u8])>, LaneError> {
    if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
        return Err(LaneError::InvalidWasm(
            "missing the WASM magic header".into(),
        ));
    }
    let mut at = 8;
    let mut sections = Vec::new();
    while at < wasm.len() {
        let id = wasm[at];
        at += 1;
        let size = read_leb_u32(wasm, &mut at)? as usize;
        let end = at
            .checked_add(size)
            .filter(|end| *end <= wasm.len())
            .ok_or_else(|| LaneError::InvalidWasm("section runs past the end".into()))?;
        sections.push((id, &wasm[at..end]));
        at = end;
    }
    Ok(sections)
}

/// A length-prefixed UTF-8 name at `*at`.
fn read_name(bytes: &[u8], at: &mut usize) -> Result<String, LaneError> {
    let len = read_leb_u32(bytes, at)? as usize;
    let end = at
        .checked_add(len)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| LaneError::InvalidWasm("name runs past its section".into()))?;
    let name = std::str::from_utf8(&bytes[*at..end])
        .map_err(|_| LaneError::InvalidWasm("name is not UTF-8".into()))?
        .to_string();
    *at = end;
    Ok(name)
}

fn read_byte(bytes: &[u8], at: &mut usize) -> Result<u8, LaneError> {
    let byte = *bytes
        .get(*at)
        .ok_or_else(|| LaneError::InvalidWasm("section is truncated".into()))?;
    *at += 1;
    Ok(byte)
}

/// Skip a table or memory `limits`: a flag byte, the minimum, and the maximum
/// when bit 0 of the flag is set.
fn skip_limits(bytes: &[u8], at: &mut usize) -> Result<(), LaneError> {
    let flags = read_byte(bytes, at)?;
    read_leb_u32(bytes, at)?;
    if flags & 1 != 0 {
        read_leb_u32(bytes, at)?;
    }
    Ok(())
}

/// The import section's function imports as `(module, name)`.
fn read_imports(payload: &[u8]) -> Result<Vec<(String, String)>, LaneError> {
    let mut at = 0;
    let count = read_leb_u32(payload, &mut at)?;
    let mut functions = Vec::new();
    for _ in 0..count {
        let module = read_name(payload, &mut at)?;
        let name = read_name(payload, &mut at)?;
        match read_byte(payload, &mut at)? {
            // function: a type index
            0 => {
                read_leb_u32(payload, &mut at)?;
                functions.push((module, name));
            }
            // table: a reference type, then limits
            1 => {
                read_byte(payload, &mut at)?;
                skip_limits(payload, &mut at)?;
            }
            // memory
            2 => skip_limits(payload, &mut at)?,
            // global: a value type and a mutability flag
            3 => {
                read_byte(payload, &mut at)?;
                read_byte(payload, &mut at)?;
            }
            other => {
                return Err(LaneError::InvalidWasm(format!(
                    "unknown import kind {other}"
                )))
            }
        }
    }
    Ok(functions)
}

/// The export section's exported function names.
fn read_function_exports(payload: &[u8]) -> Result<Vec<String>, LaneError> {
    let mut at = 0;
    let count = read_leb_u32(payload, &mut at)?;
    let mut functions = Vec::new();
    for _ in 0..count {
        let name = read_name(payload, &mut at)?;
        let kind = read_byte(payload, &mut at)?;
        read_leb_u32(payload, &mut at)?;
        if kind == 0 {
            functions.push(name);
        }
    }
    Ok(functions)
}

fn contract_strkey(id: &ContractId) -> String {
    ScAddress::Contract(id.clone()).to_string()
}

/// An `ScVal` as tagged JSON, `{"type": ..., "value": ...}`, for reading at a
/// glance: 64-bit and wider integers are decimal strings, bytes are hex, and
/// addresses are strkeys. A type with no plain form carries its XDR instead of
/// a `value`. This is a display form; `spec_decode_val` decodes by the
/// contract's own types (#545).
fn scval_json(value: &ScVal) -> Result<Value, LaneError> {
    let tagged = |ty: &str, value: Value| json!({ "type": ty, "value": value });
    Ok(match value {
        ScVal::Bool(b) => tagged("bool", json!(b)),
        ScVal::Void => tagged("void", Value::Null),
        ScVal::U32(n) => tagged("u32", json!(n)),
        ScVal::I32(n) => tagged("i32", json!(n)),
        ScVal::U64(n) => tagged("u64", json!(n.to_string())),
        ScVal::I64(n) => tagged("i64", json!(n.to_string())),
        ScVal::Timepoint(t) => tagged("timepoint", json!(t.0.to_string())),
        ScVal::Duration(d) => tagged("duration", json!(d.0.to_string())),
        ScVal::U128(parts) => {
            let n = (u128::from(parts.hi) << 64) | u128::from(parts.lo);
            tagged("u128", json!(n.to_string()))
        }
        ScVal::I128(parts) => {
            let n = (i128::from(parts.hi) << 64) | i128::from(parts.lo);
            tagged("i128", json!(n.to_string()))
        }
        ScVal::Bytes(bytes) => tagged("bytes", json!(hex(bytes.as_slice()))),
        ScVal::String(s) => tagged("string", json!(s.0.to_utf8_string_lossy())),
        ScVal::Symbol(s) => tagged("symbol", json!(s.0.to_utf8_string_lossy())),
        ScVal::Address(address) => tagged("address", json!(address.to_string())),
        ScVal::Error(error) => tagged("error", json!(format!("{error:?}"))),
        ScVal::Vec(items) => tagged(
            "vec",
            Value::Array(
                items
                    .iter()
                    .flat_map(|vec| vec.iter())
                    .map(scval_json)
                    .collect::<Result<_, _>>()?,
            ),
        ),
        ScVal::Map(entries) => tagged(
            "map",
            Value::Array(
                entries
                    .iter()
                    .flat_map(|map| map.iter())
                    .map(|entry| {
                        Ok(json!({ "key": scval_json(&entry.key)?, "value": scval_json(&entry.val)? }))
                    })
                    .collect::<Result<_, LaneError>>()?,
            ),
        ),
        other => json!({
            "type": other.name(),
            "xdr": base64(&encode(other, "ScVal")?),
        }),
    })
}

/// [`scval_json`] plus the value's own XDR, for values Go may pass on to
/// another verb.
fn scval_item(value: &ScVal) -> Result<Value, LaneError> {
    let mut item = scval_json(value)?;
    item["xdr"] = json!(base64(&encode(value, "ScVal")?));
    Ok(item)
}

fn host_function_json(host_function: &HostFunction) -> Result<Value, LaneError> {
    let not_replayable = |kind: &str| {
        json!({
            "kind": kind,
            "replayable": false,
            "reason": "only InvokeContract host functions can be replayed",
        })
    };
    Ok(match host_function {
        HostFunction::InvokeContract(call) => json!({
            "kind": "invoke_contract",
            "replayable": true,
            "contract_id": call.contract_address.to_string(),
            "function": call.function_name.0.to_utf8_string_lossy(),
            "args": call.args.iter().map(scval_item).collect::<Result<Vec<_>, _>>()?,
        }),
        HostFunction::CreateContract(_) => not_replayable("create_contract"),
        HostFunction::CreateContractV2(_) => not_replayable("create_contract_v2"),
        HostFunction::UploadContractWasm(_) => not_replayable("upload_contract_wasm"),
    })
}

fn authorized_function_json(function: &SorobanAuthorizedFunction) -> Value {
    match function {
        SorobanAuthorizedFunction::ContractFn(call) => json!({
            "kind": "contract_fn",
            "contract_id": call.contract_address.to_string(),
            "function": call.function_name.0.to_utf8_string_lossy(),
        }),
        SorobanAuthorizedFunction::CreateContractHostFn(_) => json!({ "kind": "create_contract" }),
        SorobanAuthorizedFunction::CreateContractV2HostFn(_) => {
            json!({ "kind": "create_contract_v2" })
        }
    }
}

/// One auth entry: whose authorization it is, what it authorizes at the root,
/// and the entry's XDR to hand back to the simulator.
fn auth_json(entry: &SorobanAuthorizationEntry) -> Result<Value, LaneError> {
    let (credentials, address) = match &entry.credentials {
        SorobanCredentials::SourceAccount => ("source_account", None),
        SorobanCredentials::Address(c) => ("address", Some(&c.address)),
        SorobanCredentials::AddressV2(c) => ("address_v2", Some(&c.address)),
        SorobanCredentials::AddressWithDelegates(c) => (
            "address_with_delegates",
            Some(&c.address_credentials.address),
        ),
    };
    let mut out = json!({
        "credentials": credentials,
        "root_function": authorized_function_json(&entry.root_invocation.function),
        "sub_invocations": entry.root_invocation.sub_invocations.len(),
        "entry_xdr": base64(&encode(entry, "SorobanAuthorizationEntry")?),
    });
    if let Some(address) = address {
        out["address"] = json!(address.to_string());
    }
    Ok(out)
}

fn event_json(event: &ContractEvent) -> Result<Value, LaneError> {
    let ContractEventBody::V0(body) = &event.body;
    Ok(json!({
        "type": event.type_.name().to_lowercase(),
        "contract_id": event.contract_id.as_ref().map(contract_strkey),
        "topics": body.topics.iter().map(scval_json).collect::<Result<Vec<_>, _>>()?,
        "data": scval_json(&body.data)?,
        "event_xdr": base64(&encode(event, "ContractEvent")?),
    }))
}

/// What the transaction did on chain, from its meta: the return value and
/// the contract events, for comparing a replay against (#636). Meta v3 keeps
/// both in `soroban_meta`; v4 (protocol 23) moves events onto each operation.
fn meta_json(meta: &TransactionMeta) -> Result<Value, LaneError> {
    let (return_value, events): (Option<&ScVal>, Vec<&ContractEvent>) = match meta {
        TransactionMeta::V3(v3) => match &v3.soroban_meta {
            Some(soroban) => (Some(&soroban.return_value), soroban.events.iter().collect()),
            None => (None, Vec::new()),
        },
        TransactionMeta::V4(v4) => (
            v4.soroban_meta
                .as_ref()
                .and_then(|soroban| soroban.return_value.as_ref()),
            v4.operations
                .iter()
                .flat_map(|op| op.events.iter())
                .collect(),
        ),
        // Before meta v3 there were no Soroban transactions to replay.
        TransactionMeta::V0(_) | TransactionMeta::V1(_) | TransactionMeta::V2(_) => {
            (None, Vec::new())
        }
    };
    Ok(json!({
        "meta_version": meta.discriminant(),
        "return_value": return_value.map(scval_item).transpose()?,
        "events": events.into_iter().map(event_json).collect::<Result<Vec<_>, _>>()?,
    }))
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
        ContractDataEntry, ExtensionPoint, FeeBumpTransaction, FeeBumpTransactionEnvelope,
        FeeBumpTransactionExt, Int128Parts, InvokeContractArgs, InvokeHostFunctionOp,
        LedgerEntryExt, Memo, Operation, Preconditions, PublicKey, ScContractInstance,
        ScSpecFunctionV0, ScSymbol, SequenceNumber, StringM, Transaction, TransactionExt,
        TransactionV1Envelope, UInt128Parts, Uint256,
    };
    use std::collections::HashMap;

    /// A stored entry's XDR and its `live_until` ledger.
    type StoredEntry = (Rc<[u8]>, Option<u32>);

    /// An in-memory byte ledger, standing in for the layered store.
    #[derive(Default)]
    struct Ledger(HashMap<Vec<u8>, StoredEntry>);

    impl ByteSnapshotSource for Ledger {
        fn get(&self, key_xdr: &[u8]) -> crate::lanes::SourceResult {
            Ok(self.0.get(key_xdr).cloned())
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
            base_reserve: 5_000_000,
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

    // ─── XDR helpers (#532) ────────────────────────────────────────────────────

    fn name(text: &str) -> Vec<u8> {
        let mut out = leb(text.len());
        out.extend_from_slice(text.as_bytes());
        out
    }

    #[test]
    fn imports_keep_functions_and_skip_tables_memories_and_globals() {
        let mut payload = leb(4);
        // memory with min 1, max 2
        payload.extend(name("env"));
        payload.extend(name("mem"));
        payload.extend([2, 1, 1, 2]);
        // funcref table with min 0 and no max
        payload.extend(name("env"));
        payload.extend(name("tab"));
        payload.extend([1, 0x70, 0, 0]);
        // immutable i32 global
        payload.extend(name("env"));
        payload.extend(name("g"));
        payload.extend([3, 0x7f, 0]);
        // a host function, type 0
        payload.extend(name("x"));
        payload.extend(name("_"));
        payload.extend([0, 0]);

        assert_eq!(
            read_imports(&payload).unwrap(),
            [("x".to_string(), "_".to_string())]
        );
        assert!(matches!(
            read_imports(&[1, 1, b'a', 1, b'b', 9]),
            Err(LaneError::InvalidWasm(_))
        ));
    }

    #[test]
    fn a_module_without_env_meta_has_no_interface_version() {
        let inspection = P28.inspect_wasm(&wasm_with(&[("other", vec![])])).unwrap();
        assert_eq!(inspection.custom_sections, ["other"]);
        assert_eq!(inspection.interface_version, None);
        assert!(inspection.exports.is_empty() && inspection.imports.is_empty());
    }

    fn transaction(body: OperationBody) -> Transaction {
        Transaction {
            source_account: MuxedAccount::Ed25519(Uint256([1; 32])),
            fee: 100,
            seq_num: SequenceNumber(1),
            cond: Preconditions::None,
            memo: Memo::None,
            operations: vec![Operation {
                source_account: None,
                body,
            }]
            .try_into()
            .unwrap(),
            ext: TransactionExt::V0,
        }
    }

    fn invoke_body() -> OperationBody {
        OperationBody::InvokeHostFunction(InvokeHostFunctionOp {
            host_function: HostFunction::from_xdr(invoke_xdr(), Limits::none()).unwrap(),
            auth: Default::default(),
        })
    }

    #[test]
    fn a_fee_bump_describes_its_inner_transaction() {
        let envelope = TransactionEnvelope::TxFeeBump(FeeBumpTransactionEnvelope {
            tx: FeeBumpTransaction {
                fee_source: MuxedAccount::Ed25519(Uint256([2; 32])),
                fee: 200,
                inner_tx: FeeBumpTransactionInnerTx::Tx(TransactionV1Envelope {
                    tx: transaction(invoke_body()),
                    signatures: Default::default(),
                }),
                ext: FeeBumpTransactionExt::V0,
            },
            signatures: Default::default(),
        });

        let decoded = P28
            .decode_transaction(&envelope.to_xdr(Limits::none()).unwrap(), None)
            .unwrap();

        assert_eq!(decoded["fee_bump"], true);
        let inner = MuxedAccount::Ed25519(Uint256([1; 32])).to_string();
        assert_eq!(decoded["source_account"], inner.as_str());
        assert_eq!(decoded["host_function"]["function"], "hello");
        assert_eq!(decoded["host_function"]["replayable"], true);
    }

    #[test]
    fn a_classic_transaction_is_not_replayable() {
        let envelope = TransactionEnvelope::Tx(TransactionV1Envelope {
            tx: transaction(OperationBody::Inflation),
            signatures: Default::default(),
        });

        let decoded = P28
            .decode_transaction(&envelope.to_xdr(Limits::none()).unwrap(), None)
            .unwrap();

        assert_eq!(decoded["host_function"]["kind"], Value::Null);
        assert_eq!(decoded["host_function"]["replayable"], false);
        assert!(decoded["host_function"]["reason"].is_string());
        assert_eq!(decoded["auth"], json!([]));
    }

    #[test]
    fn wide_integers_render_as_exact_decimal_strings() {
        let minus_one = ScVal::I128(Int128Parts {
            hi: -1,
            lo: u64::MAX,
        });
        assert_eq!(scval_json(&minus_one).unwrap()["value"], "-1");
        let max = ScVal::U128(UInt128Parts {
            hi: u64::MAX,
            lo: u64::MAX,
        });
        assert_eq!(scval_json(&max).unwrap()["value"], u128::MAX.to_string());
    }

    #[test]
    fn an_unknown_setting_name_is_refused() {
        assert!(matches!(
            P28.ledger_keys(&KeyRequest::ConfigSetting {
                setting: "NoSuchSetting".into()
            }),
            Err(LaneError::InvalidInput { .. })
        ));
    }

    #[test]
    fn an_external_ref_instance_names_the_entry_holding_its_wasm_hash() {
        use soroban_env_host::xdr::{ContractExecutableExternalRef, ScBytes, ScString};
        let owner = ScAddress::Contract(ContractId(Hash([9; 32])));
        let tag = ScString("v2".try_into().unwrap());
        let instance = LedgerEntry {
            last_modified_ledger_seq: 1,
            data: LedgerEntryData::ContractData(ContractDataEntry {
                ext: ExtensionPoint::V0,
                contract: ScAddress::Contract(ContractId(Hash([1; 32]))),
                key: ScVal::LedgerKeyContractInstance,
                durability: ContractDataDurability::Persistent,
                val: ScVal::ContractInstance(ScContractInstance {
                    executable: ContractExecutable::ExternalRef(ContractExecutableExternalRef {
                        executable_owner: owner.clone(),
                        tag: tag.clone(),
                    }),
                    storage: None,
                }),
            }),
            ext: LedgerEntryExt::V0,
        };
        let info = P28
            .instance_info(&instance.to_xdr(Limits::none()).unwrap())
            .unwrap();
        assert_eq!(info.executable, "external_ref");
        assert_eq!(info.wasm_hash, None);
        let external = info.external_ref.unwrap();
        assert_eq!(external.tag, "v2");
        let key: LedgerKey = LedgerKey::from_xdr(&external.key_xdr, Limits::none()).unwrap();
        let LedgerKey::ContractData(data) = key else {
            panic!("{key:?}")
        };
        assert_eq!(data.contract, owner);
        assert_eq!(data.key, ScVal::ExecutableTag(tag));

        let reference = LedgerEntry {
            last_modified_ledger_seq: 1,
            data: LedgerEntryData::ContractData(ContractDataEntry {
                ext: ExtensionPoint::V0,
                contract: owner,
                key: data.key,
                durability: ContractDataDurability::Persistent,
                val: ScVal::Bytes(ScBytes(vec![7; 32].try_into().unwrap())),
            }),
            ext: LedgerEntryExt::V0,
        };
        assert_eq!(
            P28.external_ref_wasm_hash(&reference.to_xdr(Limits::none()).unwrap())
                .unwrap(),
            [7; 32]
        );
    }
}
