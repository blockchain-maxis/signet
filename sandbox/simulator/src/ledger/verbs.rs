//! The `ledger_*` verbs (#522 schemas, #530 store): open/reset, seed, read,
//! checkpoint and rollback. Each handler validates per its schema and turns
//! the [`LayeredStore`] answer into the wire shape.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::{Lane, LaneRegistry, UnsupportedLedgerProtocol};
use crate::PROTOCOL_VERSION;

use super::store::{LayeredStore, Lookup};

/// One open ledger per process: the session every sandbox command shares.
// The passphrase, lane and close time are read by #534's simulate handler;
// `ledger_open` carries them until then.
#[allow(dead_code)]
pub struct OpenLedger {
    pub store: LayeredStore,
    pub network_passphrase: String,
    /// The lane that runs this ledger's protocol; it alone decodes the XDR
    /// the store holds (#533).
    pub lane: &'static dyn Lane,
    pub timestamp: u64,
}

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

fn decode_b64(id: &Value, path: &str, value: &str) -> Result<Vec<u8>, Value> {
    BASE64
        .decode(value)
        .map_err(|_| invalid_field(id, path, "base64"))
}

/// Base64 `LedgerKey` XDR, checked by the ledger's own lane.
fn decode_key(lane: &dyn Lane, id: &Value, path: &str, value: &str) -> Result<Vec<u8>, Value> {
    let bytes = decode_b64(id, path, value)?;
    lane.check_ledger_key(&bytes)
        .map_err(|_| invalid_field(id, path, "a base64 LedgerKey"))?;
    Ok(bytes)
}

/// Base64 `LedgerEntry` XDR, checked by the ledger's own lane.
fn decode_entry(lane: &dyn Lane, id: &Value, path: &str, value: &str) -> Result<Vec<u8>, Value> {
    let bytes = decode_b64(id, path, value)?;
    lane.check_ledger_entry(&bytes)
        .map_err(|_| invalid_field(id, path, "a base64 LedgerEntry"))?;
    Ok(bytes)
}

/// The catalogue's `unsupported_ledger_protocol` error (schema/v1/error.json):
/// `requested`/`supported` per the schema, and `networkProtocol` naming the
/// network's protocol the caller asked to simulate.
pub fn unsupported_ledger_protocol(id: &Value, unsupported: &UnsupportedLedgerProtocol) -> Value {
    error_message(
        id,
        "unsupported_ledger_protocol",
        format!("ledger protocol {} is not supported", unsupported.requested),
        json!({
            "kind": "ledger_protocol",
            "requested": unsupported.requested,
            "networkProtocol": unsupported.requested,
            "supported": unsupported.supported,
        }),
    )
}

/// `ledger_open`: open (or reset) the ledger. Opening over an existing ledger
/// discards it — a session that wants a clean start should not have to spawn
/// a fresh process.
pub fn ledger_open(
    ledger: &mut Option<OpenLedger>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let Some(passphrase) = object.get("network_passphrase").and_then(Value::as_str) else {
        return invalid_field(id, "network_passphrase", "a non-empty string");
    };
    if passphrase.is_empty() {
        return invalid_field(id, "network_passphrase", "a non-empty string");
    }
    let registry = LaneRegistry::builtin();
    let lane = match object.get("ledger_protocol") {
        None => registry.newest(),
        Some(value) => match value.as_u64() {
            Some(protocol) => {
                let protocol = u32::try_from(protocol).unwrap_or(u32::MAX);
                match registry.for_protocol(protocol) {
                    Ok(lane) => lane,
                    Err(unsupported) => return unsupported_ledger_protocol(id, &unsupported),
                }
            }
            None => return invalid_field(id, "ledger_protocol", "an integer"),
        },
    };
    let protocol = lane.ledger_protocol();
    let sequence = match object.get("sequence") {
        None => 1,
        Some(value) => match value.as_u64() {
            Some(sequence) if sequence >= 1 && sequence <= u64::from(u32::MAX) => sequence as u32,
            _ => return invalid_field(id, "sequence", "an integer >= 1"),
        },
    };
    let timestamp = match object.get("timestamp") {
        None => 0,
        Some(value) => match value.as_u64() {
            Some(timestamp) => timestamp,
            None => return invalid_field(id, "timestamp", "a non-negative integer"),
        },
    };

    *ledger = Some(OpenLedger {
        store: LayeredStore::new(sequence),
        network_passphrase: passphrase.to_string(),
        lane,
        timestamp,
    });
    json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "type": "result",
        "ledger_protocol": protocol,
        "sequence": sequence,
    })
}

/// `ledger_put`: seed override entries (#559's `--set-storage` lands here).
pub fn ledger_put(
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
    if entries.is_empty() {
        return invalid_field(id, "entries", "a non-empty array");
    }

    // Validate every entry before writing any, so a bad third entry does not
    // leave the first two half-applied.
    let mut writes = Vec::with_capacity(entries.len());
    for (index, item) in entries.iter().enumerate() {
        let Some(item) = item.as_object() else {
            return invalid_field(id, &format!("entries[{index}]"), "an object");
        };
        let Some(key_xdr) = item.get("key_xdr").and_then(Value::as_str) else {
            return invalid_field(id, &format!("entries[{index}].key_xdr"), "a string");
        };
        let Some(entry_xdr) = item.get("entry_xdr").and_then(Value::as_str) else {
            return invalid_field(id, &format!("entries[{index}].entry_xdr"), "a string");
        };
        let live_until = match item.get("live_until_ledger") {
            None | Some(Value::Null) => None,
            Some(value) => match value.as_u64() {
                Some(until) if until <= u64::from(u32::MAX) => Some(until as u32),
                _ => {
                    return invalid_field(
                        id,
                        &format!("entries[{index}].live_until_ledger"),
                        "a non-negative integer",
                    )
                }
            },
        };
        let key = match decode_key(open.lane, id, &format!("entries[{index}].key_xdr"), key_xdr) {
            Ok(key) => key,
            Err(error) => return error,
        };
        let entry = match decode_entry(
            open.lane,
            id,
            &format!("entries[{index}].entry_xdr"),
            entry_xdr,
        ) {
            Ok(entry) => entry,
            Err(error) => return error,
        };
        writes.push((key, entry, live_until));
    }

    let written = writes.len();
    for (key, entry, live_until) in writes {
        open.store.insert_override(&key, entry, live_until);
    }
    json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "type": "result",
        "written": written,
    })
}

/// `ledger_get`: read by key. Every known entry carries its provenance —
/// `source: fork|override|session`, `fetchedAtLedger`, `lastModifiedLedgerSeq`
/// — so a surprising value is always traceable. An archived entry answers
/// `entry_xdr: null` with its `live_until_ledger` still set, which is how a
/// caller tells "expired" from "never existed" (`live_until_ledger: null`).
pub fn ledger_get(ledger: &Option<OpenLedger>, id: &Value, object: &Map<String, Value>) -> Value {
    let Some(open) = ledger.as_ref() else {
        return no_open_ledger(id);
    };
    let Some(keys) = object.get("keys_xdr").and_then(Value::as_array) else {
        return invalid_field(id, "keys_xdr", "an array");
    };
    if keys.is_empty() {
        return invalid_field(id, "keys_xdr", "a non-empty array");
    }

    let mut out = Vec::with_capacity(keys.len());
    for (index, item) in keys.iter().enumerate() {
        let Some(key_xdr) = item.as_str() else {
            return invalid_field(id, &format!("keys_xdr[{index}]"), "a string");
        };
        let key = match decode_key(open.lane, id, &format!("keys_xdr[{index}]"), key_xdr) {
            Ok(key) => key,
            Err(error) => return error,
        };
        out.push(match open.store.lookup(&key) {
            Lookup::Live {
                entry,
                live_until,
                provenance,
            } => json!({
                "key_xdr": key_xdr,
                "entry_xdr": BASE64.encode(&entry),
                "live_until_ledger": live_until,
                "provenance": {
                    "source": provenance.source.as_str(),
                    "fetchedAtLedger": provenance.fetched_at_ledger,
                    "lastModifiedLedgerSeq": provenance.last_modified_ledger_seq,
                },
            }),
            Lookup::Archived {
                live_until,
                provenance,
            } => json!({
                "key_xdr": key_xdr,
                "entry_xdr": Value::Null,
                "live_until_ledger": live_until,
                "provenance": {
                    "source": provenance.source.as_str(),
                    "fetchedAtLedger": provenance.fetched_at_ledger,
                    "lastModifiedLedgerSeq": provenance.last_modified_ledger_seq,
                },
            }),
            Lookup::Absent => json!({
                "key_xdr": key_xdr,
                "entry_xdr": Value::Null,
                "live_until_ledger": Value::Null,
            }),
        });
    }
    json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "type": "result",
        "entries": out,
    })
}

/// `ledger_checkpoint`: freeze the session's writes; O(changed entries).
pub fn ledger_checkpoint(ledger: &mut Option<OpenLedger>, id: &Value) -> Value {
    let Some(open) = ledger.as_mut() else {
        return no_open_ledger(id);
    };
    let checkpoint = open.store.checkpoint();
    json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "type": "result",
        "checkpoint": format!("cp-{checkpoint}"),
    })
}

/// `ledger_rollback`: restore to a checkpoint; the checkpoint stays valid.
pub fn ledger_rollback(
    ledger: &mut Option<OpenLedger>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let Some(open) = ledger.as_mut() else {
        return no_open_ledger(id);
    };
    let Some(handle) = object.get("checkpoint").and_then(Value::as_str) else {
        return invalid_field(id, "checkpoint", "a string");
    };
    let Some(index) = handle
        .strip_prefix("cp-")
        .and_then(|raw| raw.parse::<usize>().ok())
    else {
        return invalid_field(id, "checkpoint", "a handle from ledger_checkpoint");
    };
    if open.store.rollback(index).is_err() {
        return error_message(
            id,
            "bad_request",
            format!("unknown checkpoint `{handle}`"),
            json!({ "kind": "unknown_checkpoint", "checkpoint": handle }),
        );
    }
    json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "type": "result",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lanes::p28::fixtures;

    fn key_b64(n: u32) -> String {
        BASE64.encode(fixtures::data_key_xdr(n))
    }

    fn entry_b64(n: u32, v: u32) -> String {
        BASE64.encode(fixtures::data_entry_xdr(n, v))
    }

    fn obj(raw: Value) -> Map<String, Value> {
        raw.as_object().unwrap().clone()
    }

    fn id() -> Value {
        Value::String("req-1".to_string())
    }

    fn open(ledger: &mut Option<OpenLedger>) {
        let reply = ledger_open(
            ledger,
            &id(),
            &obj(json!({ "network_passphrase": "Test SDF Network ; September 2015" })),
        );
        assert_eq!(reply["type"], "result");
        assert_eq!(reply["ledger_protocol"], 28);
        assert_eq!(reply["sequence"], 1);
    }

    #[test]
    fn open_put_get_round_trip_matches_the_wire_shapes() {
        let mut ledger = None;
        open(&mut ledger);

        let put = ledger_put(
            &mut ledger,
            &id(),
            &obj(json!({ "entries": [
                { "key_xdr": key_b64(1), "entry_xdr": entry_b64(1, 10), "live_until_ledger": 500 },
            ] })),
        );
        assert_eq!(put["type"], "result");
        assert_eq!(put["written"], 1);

        let got = ledger_get(
            &ledger,
            &id(),
            &obj(json!({ "keys_xdr": [key_b64(1), key_b64(2)] })),
        );
        assert_eq!(got["type"], "result");
        let entries = got["entries"].as_array().unwrap();
        assert_eq!(entries[0]["entry_xdr"], entry_b64(1, 10));
        assert_eq!(entries[0]["live_until_ledger"], 500);
        assert_eq!(entries[0]["provenance"]["source"], "override");
        // Unknown key: null entry, null live_until, no provenance claimed.
        assert_eq!(entries[1]["entry_xdr"], Value::Null);
        assert_eq!(entries[1]["live_until_ledger"], Value::Null);
        assert!(entries[1].get("provenance").is_none());
    }

    #[test]
    fn checkpoint_then_rollback_round_trips_through_the_handle() {
        let mut ledger = None;
        open(&mut ledger);
        let taken = ledger_checkpoint(&mut ledger, &id());
        let handle = taken["checkpoint"].as_str().unwrap().to_string();
        assert!(handle.starts_with("cp-"));

        let rolled = ledger_rollback(&mut ledger, &id(), &obj(json!({ "checkpoint": handle })));
        assert_eq!(rolled["type"], "result");

        let unknown = ledger_rollback(&mut ledger, &id(), &obj(json!({ "checkpoint": "cp-99" })));
        assert_eq!(unknown["type"], "error");
        assert_eq!(unknown["detail"]["kind"], "unknown_checkpoint");
    }

    #[test]
    fn verbs_refuse_to_run_without_an_open_ledger() {
        let ledger = None;
        let got = ledger_get(&ledger, &id(), &obj(json!({ "keys_xdr": [key_b64(1)] })));
        assert_eq!(got["detail"]["kind"], "no_open_ledger");
    }

    #[test]
    fn one_bad_entry_rejects_the_whole_put() {
        let mut ledger = None;
        open(&mut ledger);
        let put = ledger_put(
            &mut ledger,
            &id(),
            &obj(json!({ "entries": [
                { "key_xdr": key_b64(1), "entry_xdr": entry_b64(1, 1) },
                { "key_xdr": "@@not-base64@@", "entry_xdr": entry_b64(2, 2) },
            ] })),
        );
        assert_eq!(put["type"], "error");
        // Validation precedes writes: the first entry was not half-applied.
        let got = ledger_get(&ledger, &id(), &obj(json!({ "keys_xdr": [key_b64(1)] })));
        assert_eq!(got["entries"][0]["entry_xdr"], Value::Null);
    }

    #[test]
    fn opening_an_unsupported_protocol_names_the_supported_lanes() {
        let mut ledger = None;
        let reply = ledger_open(
            &mut ledger,
            &id(),
            &obj(json!({
                "network_passphrase": "Test SDF Network ; September 2015",
                "ledger_protocol": 29,
            })),
        );
        assert_eq!(reply["type"], "error");
        assert_eq!(reply["code"], "unsupported_ledger_protocol");
        assert_eq!(reply["detail"]["kind"], "ledger_protocol");
        assert_eq!(reply["detail"]["requested"], 29);
        assert_eq!(reply["detail"]["networkProtocol"], 29);
        assert_eq!(reply["detail"]["supported"], json!([28]));
        assert!(ledger.is_none(), "a refused open leaves no ledger behind");
    }

    #[test]
    fn opening_protocol_28_explicitly_selects_the_p28_lane() {
        let mut ledger = None;
        let reply = ledger_open(
            &mut ledger,
            &id(),
            &obj(json!({
                "network_passphrase": "Test SDF Network ; September 2015",
                "ledger_protocol": 28,
            })),
        );
        assert_eq!(reply["ledger_protocol"], 28);
        assert_eq!(ledger.unwrap().lane.ledger_protocol(), 28);
    }

    #[test]
    fn a_put_whose_key_is_not_a_ledger_key_is_refused_by_the_lane() {
        let mut ledger = None;
        open(&mut ledger);
        let put = ledger_put(
            &mut ledger,
            &id(),
            &obj(json!({ "entries": [
                // Valid base64 and valid XDR, but an entry where a key belongs.
                { "key_xdr": entry_b64(1, 1), "entry_xdr": entry_b64(1, 1) },
            ] })),
        );
        assert_eq!(put["type"], "error");
        assert_eq!(put["detail"]["path"], "entries[0].key_xdr");
    }
}
