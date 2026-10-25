//! The contract spec verbs (#545, #546): `spec_extract`, `spec_encode_args`
//! and `spec_decode_val`.
//!
//! Each names its executable with a `source`: the WASM itself, or an
//! installed contract whose instance and code entries are in the open
//! ledger. Decoding is the lane's job, as everywhere else; this module only
//! moves bytes and JSON.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::{ByteSnapshotSource, DecodeTarget, KeyRequest, Lane, LaneError, LaneRegistry};
use crate::ledger::fetch::FetchingSource;
use crate::ledger::verbs::OpenLedger;
use crate::PROTOCOL_VERSION;

fn invalid_field(id: &Value, path: &str, expected: &str) -> Value {
    error_message(
        id,
        "bad_request",
        format!("`{path}` must be {expected}"),
        json!({ "kind": "invalid_field", "path": path, "expected": expected }),
    )
}

/// A lane's refusal as a `bad_request`. An argument that does not fit its
/// type keeps the path-qualified message (`wallet: expected Address (G… or
/// C…), got number`) and points `detail.path` at `args.<path>`.
fn refused(id: &Value, path: &str, error: &LaneError) -> Value {
    match error {
        LaneError::Argument {
            path: arg,
            expected,
            got,
        } => error_message(
            id,
            "bad_request",
            error.to_string(),
            json!({
                "kind": "invalid_field",
                "path": format!("args.{arg}"),
                "expected": expected,
                "got": got,
            }),
        ),
        _ => error_message(
            id,
            "bad_request",
            format!("`{path}`: {error}"),
            json!({ "kind": "invalid_field", "path": path, "reason": error.to_string() }),
        ),
    }
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

/// The lane that reads specs: the open ledger's, else the newest.
fn lane_for(ledger: &Option<OpenLedger>) -> &'static dyn Lane {
    ledger
        .as_ref()
        .map_or_else(|| LaneRegistry::builtin().newest(), |open| open.lane)
}

/// The executable a `source` names, with the lane to read it. An installed
/// contract is read through `fork`, which fetches what the ledger lacks.
pub fn resolve_source(
    ledger: &Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
    field: &str,
) -> Result<(Vec<u8>, &'static dyn Lane), Value> {
    let lane = lane_for(ledger);
    let Some(Value::Object(source)) = object.get(field) else {
        return Err(invalid_field(
            id,
            field,
            "an object with `wasm_base64` or `contract_id`",
        ));
    };
    match (source.get("wasm_base64"), source.get("contract_id")) {
        (Some(Value::String(b64)), None) => {
            let wasm = BASE64
                .decode(b64)
                .map_err(|_| invalid_field(id, &format!("{field}.wasm_base64"), "base64"))?;
            Ok((wasm, lane))
        }
        (None, Some(Value::String(contract_id))) => {
            let path = format!("{field}.contract_id");
            let (Some(open), Some(fork)) = (ledger.as_ref(), fork) else {
                return Err(error_message(
                    id,
                    "bad_request",
                    "no ledger is open; send `ledger_open` first".to_string(),
                    json!({ "kind": "no_open_ledger" }),
                ));
            };
            wasm_of_contract(fork, open.lane, contract_id)
                .map(|wasm| (wasm, open.lane))
                .map_err(|reason| {
                    if let Some(failure) = fork.failure() {
                        return fetch_failed(id, open.lane, &failure);
                    }
                    error_message(
                        id,
                        "bad_request",
                        format!("`{path}`: {reason}"),
                        json!({ "kind": "invalid_field", "path": path, "reason": reason }),
                    )
                })
        }
        _ => Err(invalid_field(
            id,
            field,
            "an object with exactly one of `wasm_base64` or `contract_id`",
        )),
    }
}

/// A source that gave up, as the catalogue's `fetch_failed` error naming the
/// key in words.
pub fn fetch_failed(
    id: &Value,
    lane: &dyn Lane,
    failure: &crate::ledger::fetch::FetchFailure,
) -> Value {
    let mut detail = json!({
        "kind": failure.kind,
        "key_xdr": BASE64.encode(&failure.key),
        "key": lane.describe_key(&failure.key),
    });
    // A call kept to one contract that reached another (#552) names it.
    if let Some(contract) = lane.instance_owner(&failure.key) {
        detail["contract_id"] = json!(contract);
    }
    error_message(id, "fetch_failed", failure.message.clone(), detail)
}

/// The WASM an installed contract runs, read through `src`.
pub fn wasm_of_contract(
    src: &dyn ByteSnapshotSource,
    lane: &dyn Lane,
    contract_id: &str,
) -> Result<Vec<u8>, String> {
    let live = |key: &[u8], what: &str| match src.get(key) {
        Ok(Some((entry, _))) => Ok(entry),
        Ok(None) => Err(format!(
            "the {what} is not in the ledger (absent or archived)"
        )),
        Err(_) => Err(format!("the {what} could not be fetched")),
    };
    let key = lane
        .ledger_keys(&KeyRequest::ContractInstance {
            contract_id: contract_id.to_string(),
        })
        .map_err(|e| e.to_string())?
        .remove(0);
    let instance = live(&key.key_xdr, "contract instance")?;
    let info = lane.instance_info(&instance).map_err(|e| e.to_string())?;
    let hash = match (info.wasm_hash, info.external_ref) {
        (Some(hash), _) => hash,
        (None, Some(external)) => {
            let reference = live(
                &external.key_xdr,
                &format!("executable `{}` of {}", external.tag, external.owner),
            )?;
            lane.external_ref_wasm_hash(&reference)
                .map_err(|e| e.to_string())?
        }
        (None, None) => {
            return Err(format!(
                "contract {contract_id} is a {} contract, with no WASM spec",
                info.executable
            ))
        }
    };
    let code_key = lane
        .ledger_keys(&KeyRequest::ContractCode { wasm_hash: hash })
        .map_err(|e| e.to_string())?
        .remove(0);
    let code = live(&code_key.key_xdr, &format!("executable {}", hex(&hash)))?;
    lane.code_wasm(&code).map_err(|e| e.to_string())
}

/// `spec_extract`: the spec's entries as XDR, and the whole `SpecJson` v1
/// document as `spec`.
pub fn spec_extract(
    ledger: &Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (wasm, lane) = match resolve_source(ledger, fork, id, object, "source") {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    match lane.spec_document(&wasm) {
        Ok(spec) => result(
            id,
            json!({
                "spec_entries_xdr": spec["entriesXdr"].clone(),
                "wasm_hash": spec["wasmHash"].clone(),
                "spec": spec,
            }),
        ),
        Err(e) => refused(id, "source", &e),
    }
}

/// `spec_diff` (#570): the interfaces of `old` and `new` compared, each
/// change classed breaking, compatible or info (`spec_diff.rs`).
pub fn spec_diff(
    ledger: &Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let mut docs = Vec::new();
    let mut sparse = false;
    for field in ["old", "new"] {
        let (wasm, lane) = match resolve_source(ledger, fork, id, object, field) {
            Ok(found) => found,
            Err(reply) => return reply,
        };
        match lane.spec_document(&wasm) {
            Ok(spec) => docs.push(spec),
            Err(e) => return refused(id, field, &e),
        }
        if field == "new" {
            sparse = lane.inspect_wasm(&wasm).is_ok_and(|w| {
                w.imports
                    .iter()
                    .any(|(m, n)| (m.as_str(), n.as_str()) == crate::spec_diff::SPARSE_UNPACK)
            });
        }
    }
    result(id, crate::spec_diff::classify(&docs[0], &docs[1], sparse))
}

/// `spec_encode_args`: JSON arguments to `ScVal` XDR, one per input.
pub fn spec_encode_args(
    ledger: &Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (wasm, lane) = match resolve_source(ledger, fork, id, object, "source") {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    let Some(function) = object.get("function").and_then(Value::as_str) else {
        return invalid_field(id, "function", "a non-empty string");
    };
    let args = object.get("args").cloned().unwrap_or(Value::Null);
    if !(args.is_array() || args.is_object()) {
        return invalid_field(id, "args", "an array, or an object keyed by argument name");
    }
    match lane.encode_args(&wasm, function, &args) {
        Ok(encoded) => result(
            id,
            json!({ "args_xdr": encoded.iter().map(|v| BASE64.encode(v)).collect::<Vec<_>>() }),
        ),
        Err(e @ LaneError::InvalidInput { .. }) => refused(id, "function", &e),
        Err(e) => refused(id, "args", &e),
    }
}

/// `spec_decode_val`: XDR to JSON with the contract's types. `val_xdr` with
/// `function` decodes a return value; with `as_type`, a value of that named
/// type. `event_xdr` decodes a contract event.
pub fn spec_decode_val(
    ledger: &Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (wasm, lane) = match resolve_source(ledger, fork, id, object, "source") {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    let text = |field: &str| object.get(field).and_then(Value::as_str);
    let (path, target, b64) = match (text("val_xdr"), text("event_xdr")) {
        (Some(val), None) => match (text("function"), text("as_type")) {
            (Some(function), None) => ("function", DecodeTarget::Return(function), val),
            (None, Some(name)) => ("as_type", DecodeTarget::Type(name), val),
            _ => {
                return invalid_field(
                    id,
                    "function",
                    "set, or `as_type` set instead (exactly one), with `val_xdr`",
                )
            }
        },
        (None, Some(event)) => ("event_xdr", DecodeTarget::Event, event),
        _ => {
            return invalid_field(
                id,
                "val_xdr",
                "set, or `event_xdr` set instead (exactly one)",
            )
        }
    };
    let xdr_field = if matches!(target, DecodeTarget::Event) {
        "event_xdr"
    } else {
        "val_xdr"
    };
    let Ok(xdr) = BASE64.decode(b64) else {
        return invalid_field(id, xdr_field, "base64");
    };
    match lane.decode(&wasm, target, &xdr) {
        Ok(value) => result(id, json!({ "value": value })),
        Err(e @ (LaneError::InvalidXdr { .. } | LaneError::Decode(_))) => {
            refused(id, xdr_field, &e)
        }
        Err(e) => refused(id, path, &e),
    }
}
