//! `layout_check` (#571): whether the new build can read what the deployed
//! one stored. The reading is in the lane (`lanes/layout_impl.rs`); this
//! gathers what it reads: both executables, the stored entries (given, or
//! every entry of a contract the session knows), and the replays that
//! failed on the new build.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::LayoutReplay;
use crate::ledger::fetch::FetchingSource;
use crate::ledger::store::Lookup;
use crate::ledger::verbs::OpenLedger;
use crate::spec_verbs::resolve_source;
use crate::PROTOCOL_VERSION;

fn invalid_field(id: &Value, path: &str, expected: &str) -> Value {
    error_message(
        id,
        "bad_request",
        format!("`{path}` must be {expected}"),
        json!({ "kind": "invalid_field", "path": path, "expected": expected }),
    )
}

fn b64(id: &Value, path: &str, v: Option<&Value>) -> Result<Vec<u8>, Value> {
    v.and_then(Value::as_str)
        .and_then(|s| BASE64.decode(s).ok())
        .ok_or_else(|| invalid_field(id, path, "base64 XDR"))
}

pub fn layout_check(
    ledger: &Option<OpenLedger>,
    fork: Option<&FetchingSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let (old, lane) = match resolve_source(ledger, fork, id, object, "old") {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    let (new, _) = match resolve_source(ledger, fork, id, object, "new") {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    let mut entries = Vec::new();
    match (object.get("entries"), object.get("contract_id")) {
        (Some(Value::Array(items)), None) => {
            for (i, item) in items.iter().enumerate() {
                let key = match b64(id, &format!("entries[{i}].key_xdr"), item.get("key_xdr")) {
                    Ok(k) => k,
                    Err(e) => return e,
                };
                let entry = match b64(
                    id,
                    &format!("entries[{i}].entry_xdr"),
                    item.get("entry_xdr"),
                ) {
                    Ok(e) => e,
                    Err(e) => return e,
                };
                entries.push((key, entry));
            }
        }
        (None, Some(Value::String(contract))) => {
            let Some(open) = ledger.as_ref() else {
                return invalid_field(
                    id,
                    "contract_id",
                    "a contract in an open ledger (send ledger_open first)",
                );
            };
            // What the session knows of the contract's storage: every entry
            // for an archive fork, the keys something read for a lazy one.
            let store = open.store.borrow();
            for key in store.known_keys() {
                if lane.key_contract(&key).as_deref() != Some(contract.as_str()) {
                    continue;
                }
                match store.lookup(&key) {
                    Lookup::Live { entry, .. } | Lookup::Archived { entry, .. } => {
                        entries.push((key, entry.to_vec()))
                    }
                    Lookup::Absent => {}
                }
            }
        }
        _ => {
            return invalid_field(
                id,
                "entries",
                "an array of {key_xdr, entry_xdr}, or contract_id instead",
            )
        }
    }
    let mut replays = Vec::new();
    if let Some(items) = object.get("replays") {
        let Some(items) = items.as_array() else {
            return invalid_field(id, "replays", "an array");
        };
        for (i, r) in items.iter().enumerate() {
            let text = |f: &str| r.get(f).and_then(Value::as_str).map(str::to_string);
            let (Some(name), Some(error)) = (text("name"), text("error")) else {
                return invalid_field(id, &format!("replays[{i}]"), "{name, error, keys}");
            };
            let mut keys = Vec::new();
            for (j, k) in r
                .get("keys")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                match b64(id, &format!("replays[{i}].keys[{j}]"), Some(k)) {
                    Ok(k) => keys.push(k),
                    Err(e) => return e,
                }
            }
            replays.push(LayoutReplay { name, error, keys });
        }
    }
    match lane.layout_check(&old, &new, &entries, &replays) {
        Ok(mut out) => {
            out["version"] = json!(PROTOCOL_VERSION);
            out["id"] = id.clone();
            out["type"] = json!("result");
            out
        }
        Err(e) => error_message(
            id,
            "bad_request",
            format!("the layout could not be checked: {e}"),
            json!({ "kind": "invalid_field", "path": "old|new|entries", "reason": e.to_string() }),
        ),
    }
}
