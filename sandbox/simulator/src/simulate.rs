//! `simulate` (#534) and the verbs that set a contract up for it:
//! `contract_install`, `contract_swap`, `ledger_import` and `status`.
//!
//! A call runs through `soroban-simulation`'s
//! `simulate_invoke_host_function_op`, the function RPC's
//! `simulateTransaction` runs, with no adjustments: the resources and fee it
//! reports are raw. RPC pads instructions and fees by default, and wallets add
//! a margin on top, so a fee here is expected to sit a little below what a
//! wallet would quote.
//!
//! Every ledger read goes through the fork's fetching source (#531): what the
//! session does not hold is asked of Go mid-call, and the result lists those
//! keys as `misses`.

use std::rc::Rc;
use std::time::Instant;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::{
    ByteSnapshotSource, DecodeTarget, KeyRequest, Lane, LaneError, SimulateBytes,
    SimulateResultBytes,
};
use crate::ledger::fetch::FetchingSource;
use crate::ledger::store::{LayeredStore, Write};
use crate::ledger::verbs::{entry_of, OpenLedger};
use crate::spec_verbs::{fetch_failed, wasm_of_contract};
use crate::PROTOCOL_VERSION;

/// The account a call runs as when the request names none: the all-zero
/// ed25519 key. Recording-mode auth records whoever the contract asks for, so
/// the source account only matters to a contract that reads it.
pub const DEFAULT_SOURCE_ACCOUNT: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

fn invalid_field(id: &Value, path: &str, expected: &str) -> Value {
    error_message(
        id,
        "bad_request",
        format!("`{path}` must be {expected}"),
        json!({ "kind": "invalid_field", "path": path, "expected": expected }),
    )
}

fn no_open_ledger(id: &Value) -> Value {
    error_message(
        id,
        "bad_request",
        "no ledger is open; send `ledger_open` first".to_string(),
        json!({ "kind": "no_open_ledger" }),
    )
}

fn result(id: &Value, fields: Value) -> Value {
    let mut reply = json!({ "version": PROTOCOL_VERSION, "id": id, "type": "result" });
    if let (Value::Object(reply), Value::Object(fields)) = (&mut reply, fields) {
        reply.extend(fields);
    }
    reply
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn b64_all(items: &[Vec<u8>]) -> Vec<String> {
    items.iter().map(|b| BASE64.encode(b)).collect()
}

fn flag(id: &Value, object: &Map<String, Value>, field: &str) -> Result<bool, Value> {
    match object.get(field) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(invalid_field(id, field, "a boolean")),
    }
}

/// `simulate`: run `function` on `contract_id` with JSON `args`.
pub fn simulate(
    ledger: &mut Option<OpenLedger>,
    fork: Option<&Rc<FetchingSource>>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (Some(open), Some(fork)) = (ledger.as_mut(), fork) else {
        return no_open_ledger(id);
    };
    let lane = open.lane;
    let Some(contract_id) = object.get("contract_id").and_then(Value::as_str) else {
        return invalid_field(id, "contract_id", "a contract id (C...)");
    };
    let Some(function) = object.get("function").and_then(Value::as_str) else {
        return invalid_field(id, "function", "a non-empty string");
    };
    let args = object.get("args").cloned().unwrap_or(json!([]));
    if !(args.is_array() || args.is_object()) {
        return invalid_field(id, "args", "an array, or an object keyed by argument name");
    }
    let source_account = match object.get("source_account") {
        None => DEFAULT_SOURCE_ACCOUNT,
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return invalid_field(id, "source_account", "an account id (G...)"),
    };
    let (diagnostics, dry_run) =
        match (flag(id, object, "diagnostics"), flag(id, object, "dry_run")) {
            (Ok(d), Ok(r)) => (d, r),
            (Err(e), _) | (_, Err(e)) => return e,
        };

    // The executable, for its spec: read (and fetched) like any other entry.
    let wasm = match wasm_of_contract(fork.as_ref(), lane, contract_id) {
        Ok(wasm) => wasm,
        Err(reason) => {
            if let Some(failure) = fork.failure() {
                return fetch_failed(id, lane, &failure);
            }
            return error_message(
                id,
                "bad_request",
                format!("`contract_id`: {reason}"),
                json!({ "kind": "invalid_field", "path": "contract_id", "reason": reason }),
            );
        }
    };
    let args_xdr = match lane.encode_args(&wasm, function, &args) {
        Ok(encoded) => encoded,
        Err(e) => return argument_error(id, &e),
    };
    let host_function_xdr = match lane.invoke_contract(contract_id, function, &args_xdr) {
        Ok(xdr) => xdr,
        Err(e) => return invalid_field(id, "contract_id", &format!("a contract id (C...): {e}")),
    };
    let source_account_xdr = match lane.account_id(source_account) {
        Ok(xdr) => xdr,
        Err(e) => {
            return invalid_field(id, "source_account", &format!("an account id (G...): {e}"))
        }
    };

    let sequence = open.store.borrow().sequence();
    open.calls += 1;
    let request = SimulateBytes {
        network_passphrase: open.network_passphrase.clone(),
        sequence,
        timestamp: open.timestamp,
        host_function_xdr,
        source_account_xdr,
        prng_seed: call_seed(open.calls),
        enable_diagnostics: diagnostics,
    };
    let src: Rc<dyn ByteSnapshotSource> = fork.clone();
    let outcome = lane.simulate(&request, src);

    if let Some(failure) = fork.failure() {
        return fetch_failed(id, lane, &failure);
    }
    let run = match outcome {
        Ok(run) => run,
        Err(LaneError::NetworkConfig(reason)) => {
            return error_message(
                id,
                "fetch_failed",
                format!("the ledger lacks the network configuration a call needs: {reason}"),
                json!({ "kind": "missing_config", "reason": reason }),
            )
        }
        Err(e) => {
            return error_message(
                id,
                "bad_request",
                format!("the call could not be simulated: {e}"),
                json!({ "kind": "invalid_field", "path": "function", "reason": e.to_string() }),
            )
        }
    };

    let misses = b64_all(&fork.misses());
    let ledger_info = json!({
        "sequence": sequence,
        "timestamp": open.timestamp,
        "protocol": lane.ledger_protocol(),
    });
    match &run.return_value {
        Err(failure) => {
            let mut reply = json!({
                "version": PROTOCOL_VERSION,
                "id": id,
                "type": "contract_error",
                "kind": if failure.contract_code.is_some() { "contract" } else { "host" },
                "code": format!("Error({}, {})", failure.error_type, match failure.contract_code {
                    Some(code) => format!("#{code}"),
                    None => failure.error_code.clone(),
                }),
                "message": failure.detail,
                "diagnostic_events": b64_all(&run.diagnostic_events_xdr),
                "cost": { "cpu_insns": run.cpu_instructions, "mem_bytes": run.memory_bytes },
                "misses": misses,
                "ledger": ledger_info,
            });
            if let Some(code) = failure.contract_code {
                if let Ok(cases) = lane.error_cases(&wasm, code) {
                    if let Some(first) = cases.first() {
                        reply["message"] = json!(if first.doc.is_empty() {
                            format!(
                                "{}::{} (contract error {code})",
                                first.enum_name, first.name
                            )
                        } else {
                            first.doc.clone()
                        });
                        let mut decoded = json!({
                            "error_enum": first.enum_name,
                            "error_name": first.name,
                            "error_value": code,
                        });
                        if !first.doc.is_empty() {
                            decoded["error_doc"] = json!(first.doc);
                        }
                        if cases.len() > 1 {
                            decoded["candidates"] = Value::Array(
                                cases
                                    .iter()
                                    .map(|c| json!({ "error_enum": c.enum_name, "error_name": c.name, "error_doc": c.doc }))
                                    .collect(),
                            );
                        }
                        reply["decoded"] = decoded;
                    } else {
                        reply["message"] = json!(format!("contract error {code}"));
                    }
                }
            }
            reply
        }
        Ok(return_value_xdr) => {
            let body = success_body(lane, &wasm, function, return_value_xdr, &run);
            if !dry_run {
                apply(&mut open.store.borrow_mut(), &run);
            }
            let mut fields = body;
            fields["misses"] = json!(misses);
            fields["ledger"] = ledger_info;
            result(id, fields)
        }
    }
}

/// The PRNG seed for the session's `n`th call. Recording-mode auth draws its
/// nonces from it, so a fixed seed would hand two calls the same nonce and
/// the second would collide with the first's write. A counter keeps calls
/// distinct and a replayed session identical (#537).
fn call_seed(n: u64) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut seed = Sha256::new();
    seed.update(b"signet-simulate");
    seed.update(n.to_le_bytes());
    seed.finalize().into()
}

fn argument_error(id: &Value, e: &LaneError) -> Value {
    match e {
        LaneError::Argument {
            path,
            expected,
            got,
        } => error_message(
            id,
            "bad_request",
            e.to_string(),
            json!({ "kind": "invalid_field", "path": format!("args.{path}"), "expected": expected, "got": got }),
        ),
        LaneError::InvalidInput {
            what: "function", ..
        } => error_message(
            id,
            "bad_request",
            format!("`function`: {e}"),
            json!({ "kind": "invalid_field", "path": "function", "reason": e.to_string() }),
        ),
        other => error_message(
            id,
            "bad_request",
            format!("the contract's spec could not be read: {other}"),
            json!({ "kind": "invalid_field", "path": "contract_id", "reason": other.to_string() }),
        ),
    }
}

fn success_body(
    lane: &dyn Lane,
    wasm: &[u8],
    function: &str,
    return_value_xdr: &[u8],
    run: &SimulateResultBytes,
) -> Value {
    let decoded = lane
        .decode(wasm, DecodeTarget::Return(function), return_value_xdr)
        .ok();
    let events: Vec<Value> = run
        .contract_events_xdr
        .iter()
        .map(|event| {
            let mut item = json!({ "type": "contract", "event_xdr": BASE64.encode(event) });
            if let Ok(decoded) = lane.decode(wasm, DecodeTarget::Event, event) {
                item["decoded"] = decoded;
            }
            item
        })
        .collect();
    let mut body = json!({
        "return_value_xdr": BASE64.encode(return_value_xdr),
        "events": events,
        "diagnostic_events": b64_all(&run.diagnostic_events_xdr),
        "auth": b64_all(&run.auth_xdr),
        "modified_entries": run.modified_entries.iter().map(|m| json!({
            "key_xdr": BASE64.encode(&m.key_xdr),
            "before_xdr": m.before_xdr.as_ref().map(|b| BASE64.encode(b)),
            "after_xdr": m.entry_xdr.as_ref().map(|a| BASE64.encode(a)),
        })).collect::<Vec<_>>(),
        "cost": { "cpu_insns": run.cpu_instructions, "mem_bytes": run.memory_bytes },
        "logs": [],
    });
    if let Some(value) = decoded {
        body["return_value"] = value;
    }
    if let Some(data) = &run.transaction_data_xdr {
        if let Ok(r) = lane.transaction_resources(data) {
            body["resources"] = json!({
                "instructions": r.instructions,
                "disk_read_bytes": r.disk_read_bytes,
                "write_bytes": r.write_bytes,
                "footprint": { "read_only": b64_all(&r.read_only), "read_write": b64_all(&r.read_write) },
            });
            body["fee"] = json!({ "resource_fee": r.resource_fee });
        }
    }
    body
}

/// A successful call's writes land in the session layer, so the next call
/// sees them.
fn apply(store: &mut LayeredStore, run: &SimulateResultBytes) {
    store.apply_modified(run.modified_entries.iter().map(|m| Write {
        key: m.key_xdr.clone(),
        entry: m.entry_xdr.clone(),
        live_until: m.live_until,
    }));
}

/// `contract_install`: put an executable and an instance running it into the
/// ledger, at `contract_id` or at an id derived from the executable.
pub fn contract_install(
    ledger: &mut Option<OpenLedger>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let Some(open) = ledger.as_mut() else {
        return no_open_ledger(id);
    };
    let Some(wasm) = object
        .get("wasm_base64")
        .and_then(Value::as_str)
        .and_then(|b| BASE64.decode(b).ok())
    else {
        return invalid_field(id, "wasm_base64", "a base64 WASM executable");
    };
    let contract_id = match object.get("contract_id") {
        None => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return invalid_field(id, "contract_id", "a contract id (C...)"),
    };
    let installed = match open.lane.install(&wasm, contract_id) {
        Ok(installed) => installed,
        Err(e @ LaneError::InvalidWasm(_)) => {
            return invalid_field(id, "wasm_base64", &format!("a WASM executable: {e}"))
        }
        Err(e) => return invalid_field(id, "contract_id", &format!("a contract id (C...): {e}")),
    };
    let mut store = open.store.borrow_mut();
    for (key, entry) in installed.entries {
        // Installed code is the developer's, not the network's: never
        // archived within the session.
        store.insert_override(&key, entry, Some(u32::MAX));
    }
    open.installed.insert(installed.contract_id.clone());
    result(
        id,
        json!({ "contract_id": installed.contract_id, "wasm_hash": hex(&installed.wasm_hash) }),
    )
}

/// `contract_swap`: point an instance at another executable already in the
/// ledger, as an upgrade would, keeping its storage.
pub fn contract_swap(
    ledger: &mut Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (Some(open), Some(fork)) = (ledger.as_mut(), fork) else {
        return no_open_ledger(id);
    };
    let lane = open.lane;
    let Some(contract_id) = object.get("contract_id").and_then(Value::as_str) else {
        return invalid_field(id, "contract_id", "a contract id (C...)");
    };
    let Some(hash) = object
        .get("wasm_hash")
        .and_then(Value::as_str)
        .and_then(parse_hash)
    else {
        return invalid_field(id, "wasm_hash", "64 lowercase hex digits");
    };
    let key_of = |request: KeyRequest| {
        lane.ledger_keys(&request)
            .map(|mut keys| keys.remove(0).key_xdr)
    };
    let (instance_key, code_key) = match (
        key_of(KeyRequest::ContractInstance {
            contract_id: contract_id.to_string(),
        }),
        key_of(KeyRequest::ContractCode { wasm_hash: hash }),
    ) {
        (Ok(i), Ok(c)) => (i, c),
        (Err(e), _) | (_, Err(e)) => {
            return invalid_field(id, "contract_id", &format!("a contract id (C...): {e}"))
        }
    };
    let fetched = |key: &[u8]| fork.get(key);
    match fetched(&code_key) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return error_message(
                id,
                "bad_request",
                format!(
                    "executable {} is not in the ledger; install it first",
                    hex(&hash)
                ),
                json!({ "kind": "invalid_field", "path": "wasm_hash", "reason": "not in the ledger" }),
            )
        }
        Err(_) => {
            return fork
                .failure()
                .map_or_else(|| no_open_ledger(id), |f| fetch_failed(id, lane, &f))
        }
    }
    let instance = match fetched(&instance_key) {
        Ok(Some((entry, _))) => entry,
        Ok(None) => {
            return error_message(
                id,
                "bad_request",
                format!("contract {contract_id} is not in the ledger"),
                json!({ "kind": "invalid_field", "path": "contract_id", "reason": "not in the ledger" }),
            )
        }
        Err(_) => {
            return fork
                .failure()
                .map_or_else(|| no_open_ledger(id), |f| fetch_failed(id, lane, &f))
        }
    };
    let swapped = match lane.swap(&instance, hash) {
        Ok(swapped) => swapped,
        Err(e) => return invalid_field(id, "contract_id", &format!("a WASM contract: {e}")),
    };
    open.store
        .borrow_mut()
        .insert_override(&instance_key, swapped.entry_xdr, Some(u32::MAX));
    result(
        id,
        json!({
            "contract_id": contract_id,
            "previous_wasm_hash": hex(&swapped.previous_wasm_hash),
            "wasm_hash": hex(&hash),
        }),
    )
}

fn parse_hash(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    let mut hash = [0u8; 32];
    for (i, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(hash)
}

/// `ledger_import`: replace the ledger with a whole snapshot, which becomes
/// the fork layer at `ledger_sequence`.
pub fn ledger_import(
    ledger: &mut Option<OpenLedger>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let Some(open) = ledger.as_mut() else {
        return no_open_ledger(id);
    };
    let Some(sequence) = object
        .get("ledger_sequence")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n >= 1)
    else {
        return invalid_field(id, "ledger_sequence", "an integer >= 1");
    };
    let timestamp = match object.get("ledger_timestamp") {
        None => open.timestamp,
        Some(v) => match v.as_u64() {
            Some(t) => t,
            None => return invalid_field(id, "ledger_timestamp", "a non-negative integer"),
        },
    };
    let Some(entries) = object.get("entries").and_then(Value::as_array) else {
        return invalid_field(id, "entries", "an array");
    };
    let mut store = LayeredStore::new(sequence);
    for (index, item) in entries.iter().enumerate() {
        let at = format!("entries[{index}]");
        let Some(item) = item.as_object() else {
            return invalid_field(id, &at, "an object");
        };
        let Some(key) = item
            .get("key_xdr")
            .and_then(Value::as_str)
            .and_then(|k| BASE64.decode(k).ok())
            .filter(|k| open.lane.check_ledger_key(k).is_ok())
        else {
            return invalid_field(id, &format!("{at}.key_xdr"), "a base64 LedgerKey");
        };
        let entry = match entry_of(open.lane, id, &at, item) {
            Ok(entry) => entry,
            Err(reply) => return reply,
        };
        let live_until = item
            .get("live_until_ledger")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok());
        store.insert_base(&key, entry, live_until, sequence);
    }
    let imported = entries.len();
    *open.store.borrow_mut() = store;
    open.timestamp = timestamp;
    open.installed.clear();
    result(
        id,
        json!({ "imported": imported, "ledger_sequence": sequence }),
    )
}

/// `status`: what the simulator is holding.
pub fn status(ledger: &Option<OpenLedger>, started: Instant, id: &Value) -> Value {
    let uptime_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match ledger {
        None => result(
            id,
            json!({ "uptime_ms": uptime_ms, "ledger_open": false, "ledger_sequence": null, "entries": 0, "contracts": 0 }),
        ),
        Some(open) => {
            let store = open.store.borrow();
            result(
                id,
                json!({
                    "uptime_ms": uptime_ms,
                    "ledger_open": true,
                    "ledger_sequence": store.sequence(),
                    "entries": store.stored_entry_count(),
                    "contracts": open.installed.len(),
                }),
            )
        }
    }
}
