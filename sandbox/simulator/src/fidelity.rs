//! The verbs the nightly fidelity check (#575) uses to run the same call
//! through RPC's `simulateTransaction`: `tx_envelope` builds the
//! transaction, and `tx_resources` reads the footprint and fee from the
//! `SorobanTransactionData` RPC answers with.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::Lane;
use crate::ledger::fetch::FetchingSource;
use crate::ledger::verbs::OpenLedger;
use crate::simulate::DEFAULT_SOURCE_ACCOUNT;
use crate::spec_verbs::wasm_of_contract;
use crate::xdr_helpers::lane_for;
use crate::PROTOCOL_VERSION;

fn invalid_field(id: &Value, path: &str, expected: &str) -> Value {
    error_message(
        id,
        "bad_request",
        format!("`{path}` must be {expected}"),
        json!({ "kind": "invalid_field", "path": path, "expected": expected }),
    )
}

fn result(id: &Value, fields: Value) -> Value {
    let mut reply = json!({ "version": PROTOCOL_VERSION, "id": id, "type": "result" });
    if let (Value::Object(reply), Value::Object(fields)) = (&mut reply, fields) {
        reply.extend(fields);
    }
    reply
}

/// `tx_envelope`: the unsigned envelope for one contract call, its
/// arguments encoded by the contract's spec as `simulate` encodes them.
pub fn tx_envelope(
    ledger: &Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (Some(open), Some(fork)) = (ledger.as_ref(), fork) else {
        return invalid_field(
            id,
            "contract_id",
            "a contract in an open ledger (send ledger_open first)",
        );
    };
    let lane: &dyn Lane = open.lane;
    let text = |f: &str| {
        object
            .get(f)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let (Some(contract), Some(function)) = (text("contract_id"), text("function")) else {
        return invalid_field(id, "contract_id|function", "non-empty strings");
    };
    let source = text("source_account").unwrap_or(DEFAULT_SOURCE_ACCOUNT);
    let args = object.get("args").cloned().unwrap_or_else(|| json!({}));
    let wasm = match wasm_of_contract(fork, lane, contract) {
        Ok(wasm) => wasm,
        Err(reason) => {
            return invalid_field(
                id,
                "contract_id",
                &format!("a contract with a WASM executable ({reason})"),
            )
        }
    };
    let built = lane
        .encode_args(&wasm, function, &args)
        .and_then(|args| lane.invoke_contract(contract, function, &args))
        .and_then(|hf| Ok((hf, lane.account_id(source)?)))
        .and_then(|(hf, src)| lane.invocation_envelope(&hf, &src));
    match built {
        Ok(envelope) => result(id, json!({ "transaction_xdr": BASE64.encode(envelope) })),
        Err(e) => error_message(
            id,
            "bad_request",
            format!("the call does not build: {e}"),
            json!({ "kind": "invalid_field", "path": "args", "reason": e.to_string() }),
        ),
    }
}

/// `tx_resources`: a `SorobanTransactionData`'s footprint and resources.
pub fn tx_resources(ledger: &Option<OpenLedger>, id: &Value, object: &Map<String, Value>) -> Value {
    let lane = match lane_for(ledger, id, object) {
        Ok(lane) => lane,
        Err(error) => return error,
    };
    let Some(data) = object
        .get("transaction_data_xdr")
        .and_then(Value::as_str)
        .and_then(|s| BASE64.decode(s).ok())
    else {
        return invalid_field(id, "transaction_data_xdr", "base64 SorobanTransactionData");
    };
    match lane.transaction_resources(&data) {
        Ok(r) => result(
            id,
            json!({
                "instructions": r.instructions,
                "disk_read_bytes": r.disk_read_bytes,
                "write_bytes": r.write_bytes,
                "read_only": r.read_only.iter().map(|k| BASE64.encode(k)).collect::<Vec<_>>(),
                "read_write": r.read_write.iter().map(|k| BASE64.encode(k)).collect::<Vec<_>>(),
                "resource_fee": r.resource_fee,
            }),
        ),
        Err(e) => invalid_field(
            id,
            "transaction_data_xdr",
            &format!("base64 SorobanTransactionData ({e})"),
        ),
    }
}
