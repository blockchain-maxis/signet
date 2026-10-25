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
    AuthMode, BudgetOverride, ByteSnapshotSource, DecodeTarget, Durability, KeyRequest, Lane,
    LaneError, SimulateBytes, SimulateResultBytes, StorageOverride,
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
    let args = object
        .get("args")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!([]));
    if !(args.is_array() || args.is_object()) {
        return invalid_field(id, "args", "an array, or an object keyed by argument name");
    }
    // A real transaction is replayed with its own arguments, exactly as it
    // sent them (#636): ScVal XDR, not re-encoded through JSON.
    let given_args_xdr = match object.get("args_xdr").filter(|v| !v.is_null()) {
        None => None,
        Some(Value::Array(items)) => {
            if object.get("args").is_some_and(|v| !v.is_null()) {
                return invalid_field(id, "args_xdr", "args or args_xdr, not both");
            }
            let mut decoded = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                match item.as_str().and_then(|s| BASE64.decode(s).ok()) {
                    Some(bytes) => decoded.push(bytes),
                    None => {
                        return invalid_field(id, &format!("args_xdr[{i}]"), "an ScVal, base64 XDR")
                    }
                }
            }
            Some(decoded)
        }
        Some(_) => return invalid_field(id, "args_xdr", "an array of ScVal, base64 XDR"),
    };
    let source_account = match object.get("source_account") {
        None => DEFAULT_SOURCE_ACCOUNT,
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return invalid_field(id, "source_account", "an account id (G...)"),
    };
    let auth = match parse_auth(id, object) {
        Ok(auth) => auth,
        Err(reply) => return reply,
    };
    let auth_name = match &auth {
        AuthMode::Record => "record",
        AuthMode::Strict => "strict",
        AuthMode::Enforce(_) => "enforce",
    };
    let (ledger_sequence, ledger_timestamp, ledger_overridden) = match parse_ledger(id, object) {
        Ok(Some((seq, ts))) => (
            seq.unwrap_or_else(|| open.store.borrow().sequence()),
            ts.unwrap_or(open.timestamp),
            true,
        ),
        Ok(None) => (open.store.borrow().sequence(), open.timestamp, false),
        Err(reply) => return reply,
    };
    let budget = match parse_budget(id, object) {
        Ok(budget) => budget,
        Err(reply) => return reply,
    };
    let (diagnostics, dry_run) =
        match (flag(id, object, "diagnostics"), flag(id, object, "dry_run")) {
            (Ok(d), Ok(r)) => (d, r),
            (Err(e), _) | (_, Err(e)) => return e,
        };
    // `related: false` keeps the call to this contract (#552).
    let related = match object.get("related") {
        None => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => return invalid_field(id, "related", "a boolean"),
    };
    if !related {
        fork.restrict_to(contract_id);
    }
    // A pinned `call_index` runs with that call's seed and leaves the
    // session's count alone: signet dev runs each saved call on the deployed
    // and the new code (#566), and both sides must draw the same PRNG.
    let pinned_index = match object.get("call_index") {
        None => None,
        Some(v) => match v.as_u64() {
            Some(n) => Some(n),
            None => return invalid_field(id, "call_index", "a non-negative integer"),
        },
    };
    // `adjustment: "rpc"` pads resources and fee as RPC's
    // simulateTransaction does by default, for comparing with it (#575).
    let rpc_adjustment = match object.get("adjustment").and_then(Value::as_str) {
        None if object.get("adjustment").is_none() => false,
        Some("none") => false,
        Some("rpc") => true,
        _ => return invalid_field(id, "adjustment", "\"none\" or \"rpc\""),
    };
    let max_frames = match crate::trace::parse(object.get("trace")) {
        Ok(max) => max,
        Err(want) => return invalid_field(id, "trace", want),
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
    let args_xdr = match given_args_xdr {
        Some(given) => given,
        None => match lane.encode_args(&wasm, function, &args) {
            Ok(encoded) => encoded,
            Err(e) => return argument_error(id, &e),
        },
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

    let sequence = ledger_sequence;
    let seed = match pinned_index {
        Some(n) => call_seed(&open.session_id, n),
        None => {
            open.calls += 1;
            call_seed(&open.session_id, open.calls - 1)
        }
    };
    let request = SimulateBytes {
        network_passphrase: open.network_passphrase.clone(),
        sequence,
        timestamp: ledger_timestamp,
        base_reserve: open.base_reserve,
        host_function_xdr,
        source_account_xdr,
        prng_seed: seed,
        // A trace is read from the host's diagnostic events (#541).
        enable_diagnostics: diagnostics || max_frames.is_some(),
        budget,
        auth,
        rpc_adjustment,
    };
    // An override moves the ledger for this call only: archival and new
    // entries' TTLs follow it, then the session's own sequence is back.
    let session_sequence = open.store.borrow().sequence();
    open.store.borrow_mut().set_sequence(sequence);
    let src: Rc<dyn ByteSnapshotSource> = fork.clone();
    let outcome = lane.simulate(&request, src);
    open.store.borrow_mut().set_sequence(session_sequence);

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
        Err(e @ LaneError::InvalidInput { .. }) => {
            let LaneError::InvalidInput { what, .. } = &e else {
                unreachable!()
            };
            return error_message(
                id,
                "bad_request",
                format!("`{what}`: {e}"),
                json!({ "kind": "invalid_field", "path": what, "reason": e.to_string() }),
            );
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

    // Canonical order (#537): by XDR bytes, not by when they were fetched.
    let mut miss_keys = fork.misses();
    miss_keys.sort();
    let misses = b64_all(&miss_keys);
    let mut ledger_info = json!({
        "sequence": sequence,
        "timestamp": ledger_timestamp,
        "protocol": lane.ledger_protocol(),
    });
    if ledger_overridden {
        ledger_info["overridden"] = json!(true);
    }
    let archived: Vec<Value> = fork
        .archived()
        .iter()
        .map(|(key, live_until)| {
            json!({
                "key_xdr": BASE64.encode(key),
                "key": lane.describe_key(key),
                "live_until_ledger": live_until,
                "outcome": if is_temporary_key(key) { "expired" } else { "restored" },
            })
        })
        .collect();
    let contracts = related_contracts(lane, &open.store.borrow(), &fork.instances(), contract_id);
    let trace = max_frames.map(|max| {
        let cx = crate::trace::Context {
            lane,
            src: &**fork,
            store: &open.store,
            root_args_xdr: &args_xdr,
            ledger: sequence,
            ledger_overridden,
        };
        crate::trace::build(&cx, &run, max)
    });
    let diagnostic_events = if diagnostics {
        b64_all(&run.diagnostic_events_xdr)
    } else {
        Vec::new()
    };
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
                "diagnostic_events": diagnostic_events,
                "cost": { "cpu_insns": run.cpu_instructions, "mem_bytes": run.memory_bytes },
                "misses": misses,
                "ledger": ledger_info,
                "seed": hex(&seed),
                "auth_mode": auth_name,
            });
            if !archived.is_empty() {
                reply["archived"] = json!(archived);
            }
            if let Some(trace) = trace {
                reply["trace"] = trace;
            }
            reply["contracts"] = json!(contracts);
            if run.budget.overridden {
                reply["budget"] = budget_json(&run);
            }
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
            fields["diagnostic_events"] = json!(diagnostic_events);
            fields["misses"] = json!(misses);
            fields["ledger"] = ledger_info;
            fields["seed"] = json!(hex(&seed));
            fields["auth_mode"] = json!(auth_name);
            if !archived.is_empty() {
                fields["archived"] = json!(archived);
            }
            if let Some(trace) = trace {
                fields["trace"] = trace;
            }
            fields["contracts"] = json!(contracts);
            if run.budget.overridden {
                fields["budget"] = budget_json(&run);
            }
            result(id, fields)
        }
    }
}

/// The PRNG seed for the session's `n`th call: sha256(session id ‖ n as a
/// big-endian u64), never random (#537). A contract's `env.prng()` and
/// recording-mode auth nonces both draw from it, so a replayed session
/// produces the same values, while two calls in one session never share a
/// nonce (a fixed seed would make the second collide with the first's
/// write).
pub fn call_seed(session_id: &str, n: u64) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut seed = Sha256::new();
    seed.update(session_id.as_bytes());
    seed.update(n.to_be_bytes());
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
        "auth_entries": run
            .auth_xdr
            .iter()
            .filter_map(|a| lane.decode_auth(a).ok())
            .collect::<Vec<_>>(),
        "modified_entries": sorted_changes(run).iter().map(|m| json!({
            "key_xdr": BASE64.encode(&m.key_xdr),
            "before_xdr": m.before_xdr.as_ref().map(|b| BASE64.encode(b)),
            "after_xdr": m.entry_xdr.as_ref().map(|a| BASE64.encode(a)),
            "live_until_ledger": m.live_until,
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

/// The other contracts a call read the instance of (#552), in the order it
/// reached them: their executable, and a Stellar Asset Contract's asset.
fn related_contracts(
    lane: &dyn Lane,
    store: &crate::ledger::store::LayeredStore,
    instances: &[String],
    contract_id: &str,
) -> Vec<Value> {
    instances
        .iter()
        .filter(|c| c.as_str() != contract_id)
        .map(|c| {
            let mut item = json!({ "contract_id": c });
            let info = lane
                .ledger_keys(&KeyRequest::ContractInstance {
                    contract_id: c.clone(),
                })
                .ok()
                .and_then(|keys| keys.into_iter().next())
                .and_then(|key| match store.lookup(&key.key_xdr) {
                    crate::ledger::store::Lookup::Live { entry, .. }
                    | crate::ledger::store::Lookup::Archived { entry, .. } => {
                        lane.instance_info(&entry).ok()
                    }
                    crate::ledger::store::Lookup::Absent => None,
                });
            if let Some(info) = info {
                item["executable"] = json!(info.executable);
                if let Some(asset) = info.asset {
                    item["asset"] = json!(asset);
                }
            }
            item
        })
        .collect()
}

/// A temporary contract-data key: `LedgerKey` arm 6 (CONTRACT_DATA), whose
/// last field is the durability, TEMPORARY = 0. Expired, such an entry is
/// gone for good; an archived persistent one is restored by the call.
fn is_temporary_key(key_xdr: &[u8]) -> bool {
    key_xdr.len() > 8
        && key_xdr[..4] == [0, 0, 0, 6]
        && key_xdr[key_xdr.len() - 4..] == [0, 0, 0, 0]
}

/// `ledger: {sequence?, timestamp?}` (#558): this call runs at another
/// ledger than the session's.
type LedgerOverride = Option<(Option<u32>, Option<u64>)>;

fn parse_ledger(id: &Value, object: &Map<String, Value>) -> Result<LedgerOverride, Value> {
    let Some(raw) = object.get("ledger") else {
        return Ok(None);
    };
    let Some(raw) = raw.as_object() else {
        return Err(invalid_field(
            id,
            "ledger",
            "an object with `sequence` and/or `timestamp`",
        ));
    };
    let sequence = match raw.get("sequence") {
        None => None,
        Some(v) => match v
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n >= 1)
        {
            Some(n) => Some(n),
            None => {
                return Err(invalid_field(
                    id,
                    "ledger.sequence",
                    "a ledger sequence >= 1",
                ))
            }
        },
    };
    let timestamp = match raw.get("timestamp") {
        None => None,
        Some(v) => match v.as_u64() {
            Some(t) => Some(t),
            None => return Err(invalid_field(id, "ledger.timestamp", "Unix seconds")),
        },
    };
    Ok(Some((sequence, timestamp)))
}

/// `auth_mode` (record, strict, enforce) and, for enforce, `auth_entries`
/// (#557).
fn parse_auth(id: &Value, object: &Map<String, Value>) -> Result<AuthMode, Value> {
    match object.get("auth_mode").and_then(Value::as_str) {
        None if object.get("auth_mode").is_none() => Ok(AuthMode::Record),
        Some("record") => Ok(AuthMode::Record),
        Some("strict") => Ok(AuthMode::Strict),
        Some("enforce") => {
            let Some(entries) = object.get("auth_entries").and_then(Value::as_array) else {
                return Err(invalid_field(
                    id,
                    "auth_entries",
                    "an array of base64 SorobanAuthorizationEntry (required with enforce)",
                ));
            };
            let mut out = Vec::with_capacity(entries.len());
            for (i, e) in entries.iter().enumerate() {
                match e.as_str().and_then(|b| BASE64.decode(b).ok()) {
                    Some(bytes) => out.push(bytes),
                    None => return Err(invalid_field(id, &format!("auth_entries[{i}]"), "base64")),
                }
            }
            Ok(AuthMode::Enforce(out))
        }
        _ => Err(invalid_field(
            id,
            "auth_mode",
            "\"record\", \"strict\" or \"enforce\"",
        )),
    }
}

/// `budget: {instructions?, mem_bytes?}` (#536).
fn parse_budget(id: &Value, object: &Map<String, Value>) -> Result<Option<BudgetOverride>, Value> {
    let Some(raw) = object.get("budget") else {
        return Ok(None);
    };
    let Some(raw) = raw.as_object() else {
        return Err(invalid_field(
            id,
            "budget",
            "an object with `instructions`, `mem_bytes` and/or `unlimited`",
        ));
    };
    let field = |name: &str| match raw.get(name) {
        None => Ok(None),
        Some(v) => v
            .as_u64()
            .map(Some)
            .ok_or_else(|| invalid_field(id, &format!("budget.{name}"), "a positive integer")),
    };
    let unlimited = match raw.get("unlimited") {
        None => false,
        Some(v) => v
            .as_bool()
            .ok_or_else(|| invalid_field(id, "budget.unlimited", "true or false"))?,
    };
    Ok(Some(BudgetOverride {
        instructions: field("instructions")?,
        mem_bytes: field("mem_bytes")?,
        unlimited,
    }))
}

/// The limits an overridden call ran under, for its result.
fn budget_json(run: &SimulateResultBytes) -> Value {
    json!({
        "instructions": run.budget.instructions,
        "mem_bytes": run.budget.mem_bytes,
    })
}

/// Modified entries in canonical order: by key XDR (#537).
fn sorted_changes(run: &SimulateResultBytes) -> Vec<&crate::lanes::EntryChangeBytes> {
    let mut changes: Vec<_> = run.modified_entries.iter().collect();
    changes.sort_by(|a, b| a.key_xdr.cmp(&b.key_xdr));
    changes
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

/// `contract_info`: what a contract is, read (and fetched) without running
/// it: its executable, the executable's hash and code (fetched too, so a
/// fork holds it), and how many entries its instance storage holds.
pub fn contract_info(
    ledger: &Option<OpenLedger>,
    fork: Option<&Rc<FetchingSource>>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (Some(open), Some(fork)) = (ledger.as_ref(), fork) else {
        return no_open_ledger(id);
    };
    let lane = open.lane;
    let Some(contract_id) = object.get("contract_id").and_then(Value::as_str) else {
        return invalid_field(id, "contract_id", "a contract id (C...)");
    };
    let instance_key = match lane.ledger_keys(&KeyRequest::ContractInstance {
        contract_id: contract_id.to_string(),
    }) {
        Ok(mut keys) => keys.remove(0).key_xdr,
        Err(e) => return invalid_field(id, "contract_id", &format!("a contract id (C...): {e}")),
    };
    let fetch_error = || {
        fork.failure()
            .map_or_else(|| no_open_ledger(id), |f| fetch_failed(id, lane, &f))
    };
    let (instance, live_until) = match fork.get(&instance_key) {
        Ok(Some(found)) => found,
        Ok(None) => {
            return error_message(
                id,
                "bad_request",
                format!("there is no contract {contract_id} in this ledger"),
                json!({ "kind": "invalid_field", "path": "contract_id", "reason": "no instance entry" }),
            )
        }
        Err(_) => return fetch_error(),
    };
    let info = match lane.instance_info(&instance) {
        Ok(info) => info,
        Err(e) => return invalid_field(id, "contract_id", &format!("a contract instance: {e}")),
    };
    let mut wasm_hash = info.wasm_hash;
    if let Some(external) = &info.external_ref {
        match fork.get(&external.key_xdr) {
            Ok(Some((reference, _))) => match lane.external_ref_wasm_hash(&reference) {
                Ok(hash) => wasm_hash = Some(hash),
                Err(e) => return invalid_field(id, "contract_id", &format!("a contract whose executable reference resolves: {e}")),
            },
            Ok(None) => {
                return error_message(
                    id,
                    "bad_request",
                    format!(
                        "contract {contract_id} runs executable `{}` of {}, which is not in this ledger",
                        external.tag, external.owner
                    ),
                    json!({ "kind": "invalid_field", "path": "contract_id", "reason": "executable reference missing" }),
                )
            }
            Err(_) => return fetch_error(),
        }
    }
    let mut reply = json!({
        "contract_id": contract_id,
        "executable": info.executable,
        "wasm_hash": wasm_hash.map(|h| hex(&h)),
        "external_ref": info.external_ref.as_ref().map(|r| json!({ "owner": r.owner, "tag": r.tag })),
        "storage_entries": info.storage_entries,
        "instance_live_until": live_until,
        "misses": [],
    });
    if let Some(hash) = wasm_hash {
        let code_key = match lane.ledger_keys(&KeyRequest::ContractCode { wasm_hash: hash }) {
            Ok(mut keys) => keys.remove(0).key_xdr,
            Err(e) => return invalid_field(id, "contract_id", &e.to_string()),
        };
        match fork.get(&code_key) {
            Ok(Some((code, _))) => {
                let wasm = lane.code_wasm(&code).unwrap_or_default();
                reply["wasm_size"] = json!(wasm.len());
                // The executable itself, for a repro bundle (#572).
                if object.get("include_wasm") == Some(&Value::Bool(true)) {
                    reply["wasm_base64"] = json!(BASE64.encode(&wasm));
                }
            }
            Ok(None) => {
                return error_message(
                    id,
                    "bad_request",
                    format!(
                        "contract {contract_id} runs executable {}, which is not in this ledger",
                        hex(&hash)
                    ),
                    json!({ "kind": "invalid_field", "path": "contract_id", "reason": "executable missing" }),
                )
            }
            Err(_) => return fetch_error(),
        }
    }
    reply["misses"] = json!(b64_all(&fork.misses()));
    result(id, reply)
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
    // Parse it as the lane would before it lands in the ledger, and refuse
    // an executable built for a newer protocol than the lane runs.
    match open.lane.inspect_wasm(&wasm) {
        Ok(inspection) => {
            if let Some(v) = inspection.interface_version {
                if v.protocol > open.lane.ledger_protocol() {
                    return error_message(
                        id,
                        "bad_request",
                        format!(
                            "this executable targets ledger protocol {}, but the open ledger runs protocol {}; open the ledger at protocol {} (or rebuild the contract for {})",
                            v.protocol,
                            open.lane.ledger_protocol(),
                            v.protocol,
                            open.lane.ledger_protocol()
                        ),
                        json!({
                            "kind": "invalid_field",
                            "path": "wasm_base64",
                            "contract_protocol": v.protocol,
                            "lane_protocol": open.lane.ledger_protocol(),
                        }),
                    );
                }
            }
        }
        Err(e) => return invalid_field(id, "wasm_base64", &format!("a WASM executable: {e}")),
    }
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
    // A swap is what an upgrade transaction leaves behind, so by default it
    // is a session write: visible at once, undone by a rollback.
    let session_layer = match object.get("layer").and_then(Value::as_str) {
        None if object.get("layer").is_none() => true,
        Some("override") => false,
        Some("session") => true,
        _ => return invalid_field(id, "layer", "\"override\" or \"session\""),
    };
    let mode = match object.get("mode") {
        None => None,
        Some(Value::String(m)) if m == "instance" || m == "ref" => Some(m.as_str()),
        Some(_) => return invalid_field(id, "mode", "\"instance\" or \"ref\""),
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
    let (instance, instance_ttl) = match fetched(&instance_key) {
        Ok(Some(found)) => found,
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
    let info = match lane.instance_info(&instance) {
        Ok(info) => info,
        Err(e) => return invalid_field(id, "contract_id", &format!("a WASM contract: {e}")),
    };

    // A CAP-85 instance can change two ways, with different reach, so the
    // caller must say which (#539).
    let (key, swapped, ttl, mode) = match (&info.external_ref, mode) {
        (Some(external), None) => {
            return error_message(
                id,
                "bad_request",
                format!(
                    "contract {contract_id} runs executable `{}` of {} through a reference; choose mode \"instance\" to repoint this contract only, or mode \"ref\" to replace the reference's target, which changes every contract sharing it",
                    external.tag, external.owner
                ),
                json!({ "kind": "invalid_field", "path": "mode", "expected": ["instance", "ref"] }),
            )
        }
        (Some(external), Some("ref")) => {
            let (reference, ref_ttl) = match fetched(&external.key_xdr) {
                Ok(Some(found)) => found,
                Ok(None) => {
                    return error_message(
                        id,
                        "bad_request",
                        format!("the reference `{}` of {} is not in the ledger", external.tag, external.owner),
                        json!({ "kind": "invalid_field", "path": "contract_id", "reason": "executable reference missing" }),
                    )
                }
                Err(_) => return fork.failure().map_or_else(|| no_open_ledger(id), |f| fetch_failed(id, lane, &f)),
            };
            match lane.retarget_external_ref(&reference, hash) {
                Ok(swapped) => (external.key_xdr.clone(), swapped, ref_ttl, "ref"),
                Err(e) => return invalid_field(id, "contract_id", &format!("a contract with a usable reference: {e}")),
            }
        }
        (external, _) => {
            let mut swapped = match lane.swap(&instance, hash) {
                Ok(swapped) => swapped,
                Err(e) => return invalid_field(id, "contract_id", &format!("a WASM contract: {e}")),
            };
            // Repointing an ExternalRef instance: what it ran is in the
            // reference entry.
            if let Some(external) = external {
                if let Ok(Some((reference, _))) = fetched(&external.key_xdr) {
                    swapped.previous_wasm_hash = lane.external_ref_wasm_hash(&reference).ok();
                }
            }
            (instance_key, swapped, instance_ttl, "instance")
        }
    };

    // The swap rewrites one entry and keeps its TTL, as an on-chain upgrade
    // does; no constructor runs and no event is emitted.
    let mut store = open.store.borrow_mut();
    if !session_layer {
        // The session layer sits above the overrides: a session that already
        // wrote this entry would hide an override-layer swap.
        if let crate::ledger::store::Lookup::Live { provenance, .. } = store.lookup(&key) {
            if provenance.source == crate::ledger::store::Source::Session {
                return error_message(
                    id,
                    "bad_request",
                    "this session has already written the entry the swap rewrites, so an override-layer swap would be hidden beneath it; swap in the session layer, or roll back first".to_string(),
                    json!({ "kind": "invalid_field", "path": "layer", "reason": "shadowed by a session write" }),
                );
            }
        }
    }
    if session_layer {
        store.apply_modified([Write {
            key,
            entry: Some(swapped.entry_xdr),
            live_until: ttl,
        }]);
    } else {
        store.insert_override(&key, swapped.entry_xdr, ttl);
    }
    result(
        id,
        json!({
            "contract_id": contract_id,
            "previous_wasm_hash": swapped.previous_wasm_hash.map(|h| hex(&h)),
            "wasm_hash": hex(&hash),
            "mode": mode,
            "layer": if session_layer { "session" } else { "override" },
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

/// `ledger_apply`: write entries into the session layer, as a call's writes
/// land there, so Go can restore a saved session in a new process (#555).
/// A null `entry_xdr` deletes the key.
pub fn ledger_apply(
    ledger: &mut Option<OpenLedger>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let Some(open) = ledger.as_mut() else {
        return no_open_ledger(id);
    };
    let Some(entries) = object.get("entries").and_then(Value::as_array) else {
        return invalid_field(id, "entries", "an array");
    };
    let mut writes = Vec::with_capacity(entries.len());
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
        let entry = match item.get("entry_xdr") {
            None | Some(Value::Null) => None,
            Some(Value::String(e)) => match BASE64
                .decode(e)
                .ok()
                .filter(|b| open.lane.check_ledger_entry(b).is_ok())
            {
                Some(bytes) => Some(bytes),
                None => {
                    return invalid_field(
                        id,
                        &format!("{at}.entry_xdr"),
                        "a base64 LedgerEntry or null",
                    )
                }
            },
            Some(_) => {
                return invalid_field(
                    id,
                    &format!("{at}.entry_xdr"),
                    "a base64 LedgerEntry or null",
                )
            }
        };
        let live_until = item
            .get("live_until_ledger")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok());
        writes.push(Write {
            key,
            entry,
            live_until,
        });
    }
    let applied = writes.len();
    open.store.borrow_mut().apply_modified(writes);
    result(id, json!({ "applied": applied }))
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

/// The second half of `ledger_open` (#535): the network's `ConfigSetting`
/// entries must be there, from `entries` or fetched from Go, and the lane
/// must load them. Fees, limits and TTLs come from them, never from
/// defaults, so a missing setting fails the open with `fetch_failed` /
/// `missing_config` naming every one that is missing.
pub fn load_network_config(
    open: &mut OpenLedger,
    fork: &Rc<FetchingSource>,
    id: &Value,
) -> Result<Value, Value> {
    let lane = open.lane;
    let keys = lane.ledger_keys(&KeyRequest::NetworkConfig).map_err(|e| {
        invalid_field(
            id,
            "ledger_protocol",
            &format!("a protocol with a network config: {e}"),
        )
    })?;
    let mut missing = Vec::new();
    for key in &keys {
        // In deny mode an unknown key is simply missing; asking the source
        // would record a denial instead.
        if open.fetch == crate::ledger::fetch::FetchMode::Deny
            && !open.store.borrow().knows(&key.key_xdr)
        {
            missing.push(key.subject.clone());
            continue;
        }
        match fork.get(&key.key_xdr) {
            Ok(Some(_)) => {}
            Ok(None) => missing.push(key.subject.clone()),
            Err(_) => {
                return Err(fork
                    .failure()
                    .map_or_else(|| no_open_ledger(id), |f| fetch_failed(id, lane, &f)))
            }
        }
    }
    if !missing.is_empty() {
        return Err(error_message(
            id,
            "fetch_failed",
            format!(
                "the ledger lacks network configuration the host needs: {} (fetch the `network_config` keys from `xdr_keys`, or pass them in `entries`)",
                missing.join(", ")
            ),
            json!({ "kind": "missing_config", "missing": missing }),
        ));
    }
    let src: Rc<dyn ByteSnapshotSource> = fork.clone();
    let config = lane.network_config(src).map_err(|e| {
        error_message(
            id,
            "fetch_failed",
            format!("the ledger's network configuration does not load: {e}"),
            json!({ "kind": "missing_config", "reason": e.to_string() }),
        )
    })?;
    open.network_config = config.clone();
    Ok(config)
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
                    "network_config": open.network_config,
                    "base_reserve": open.base_reserve,
                }),
            )
        }
    }
}

/// `storage_override` (#559): set or remove one storage entry of a contract
/// in the override layer, so a call runs against state the network never
/// had, and every result says it was overridden.
///
/// `durability` is `instance`, `persistent` or `temporary`; `key` and `value`
/// are storage expressions (`Owner("alice")`, `u32:5`, typed ScVal JSON),
/// read against the contract's spec when it has one. A persistent or
/// temporary entry is the contract's own (it is keyed by `contract_id`) and
/// lives until `live_until`, or the network's minimum TTL from the current
/// ledger; an instance override rewrites the instance's storage map.
pub fn storage_override(
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
    let durability = match object.get("durability").and_then(Value::as_str) {
        Some("instance") => Durability::Instance,
        Some("persistent") => Durability::Persistent,
        Some("temporary") => Durability::Temporary,
        _ => return invalid_field(id, "durability", "instance, persistent or temporary"),
    };
    let Some(key) = object.get("key").and_then(Value::as_str) else {
        return invalid_field(id, "key", crate::lanes::STORAGE_SHAPES);
    };
    let unset = matches!(object.get("unset"), Some(Value::Bool(true)));
    let value = object.get("value").and_then(Value::as_str);
    if unset == value.is_some() {
        return invalid_field(id, "value", "a value to set, or `unset: true`, not both");
    }
    let live_until = match object.get("live_until") {
        None => None,
        Some(v) => match v.as_u64().and_then(|n| u32::try_from(n).ok()) {
            Some(n) => Some(n),
            None => return invalid_field(id, "live_until", "a ledger sequence"),
        },
    };

    // The spec, for typed keys and values; a contract without one (or one
    // the fork cannot read) still takes untyped expressions.
    let wasm = wasm_of_contract(&**fork, lane, contract_id).ok();
    let instance_key = lane
        .ledger_keys(&KeyRequest::ContractInstance {
            contract_id: contract_id.to_string(),
        })
        .ok()
        .and_then(|keys| keys.into_iter().next());
    let instance = instance_key
        .as_ref()
        .and_then(|k| fork.get(&k.key_xdr).ok().flatten());
    if let Some(failure) = fork.failure() {
        return fetch_failed(id, lane, &failure);
    }
    let write = match lane.override_storage(&StorageOverride {
        wasm: wasm.as_deref(),
        contract_id,
        durability,
        key,
        value,
        instance_entry: instance.as_ref().map(|(entry, _)| &**entry),
    }) {
        Ok(write) => write,
        Err(LaneError::Argument {
            path,
            expected,
            got,
        }) => {
            return error_message(
                id,
                "bad_request",
                format!("{path}: expected {expected}, got {got}"),
                json!({ "kind": "invalid_field", "path": path, "expected": expected, "got": got }),
            )
        }
        Err(LaneError::InvalidInput { what, detail }) => return invalid_field(id, what, &detail),
        Err(e) => return invalid_field(id, "key", &e.to_string()),
    };

    let mut store = open.store.borrow_mut();
    let sequence = store.sequence();
    let ttl = |field: &str| {
        open.network_config[field]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(1)
    };
    let live_until = match durability {
        Durability::Instance => instance.as_ref().and_then(|(_, live)| *live),
        Durability::Persistent => {
            Some(live_until.unwrap_or(sequence.saturating_add(ttl("min_persistent_ttl"))))
        }
        Durability::Temporary => {
            Some(live_until.unwrap_or(sequence.saturating_add(ttl("min_temporary_ttl"))))
        }
    };
    match &write.entry_xdr {
        Some(entry) => store.insert_override(&write.key_xdr, entry.clone(), live_until),
        None => store.remove_override(&write.key_xdr),
    }
    result(
        id,
        json!({
            "key_xdr": BASE64.encode(&write.key_xdr),
            "key": write.describe,
            "removed": write.entry_xdr.is_none(),
            "live_until_ledger": live_until,
        }),
    )
}
