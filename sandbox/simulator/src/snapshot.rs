//! `snapshot_read` (#554): a `stellar snapshot create` file, as the entries
//! a fork holds.
//!
//! `stellar snapshot create --address <C…>` writes a consistent snapshot of
//! all of a contract's entries at a history-archive checkpoint, as
//! `soroban-ledger-snapshot`'s `LedgerSnapshot` JSON, whose entries are
//! stellar-xdr's serde JSON. Go keeps a fork's entries in the RPC form
//! (`key_xdr`, `data_xdr`, `last_modified_ledger_seq`, `ext_xdr`,
//! `live_until_ledger`) and never parses XDR, so this reads the file with the
//! crate the CLI wrote it with and answers in that form, with the ledger the
//! snapshot was taken at. It is stateless: no ledger needs to be open.
//!
//! The crate's release pins the p28 host, so a build without the p28 lane
//! cannot read snapshots and says so.

use serde_json::{json, Map, Value};

use crate::dispatch::error_message;

pub fn snapshot_read(id: &Value, object: &Map<String, Value>) -> Value {
    let Some(text) = object.get("snapshot_json").and_then(Value::as_str) else {
        return error_message(
            id,
            "bad_request",
            "`snapshot_json`: expected the snapshot file's text".into(),
            json!({ "kind": "invalid_field", "path": "snapshot_json", "reason": "expected a string" }),
        );
    };
    read(id, text)
}

#[cfg(feature = "lane-p28")]
fn read(id: &Value, text: &str) -> Value {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    use crate::PROTOCOL_VERSION;

    let snapshot = match crate::lanes::read_snapshot(text) {
        Ok(s) => s,
        Err(e) => {
            return error_message(
                id,
                "bad_request",
                format!("`snapshot_json` is not a LedgerSnapshot: {e}"),
                json!({ "kind": "invalid_field", "path": "snapshot_json", "reason": e }),
            )
        }
    };
    let entries: Vec<Value> = snapshot
        .entries
        .iter()
        .map(|e| {
            json!({
                "key_xdr": BASE64.encode(&e.key_xdr),
                "data_xdr": BASE64.encode(&e.data_xdr),
                "last_modified_ledger_seq": e.last_modified_ledger_seq,
                "ext_xdr": BASE64.encode(&e.ext_xdr),
                "live_until_ledger": e.live_until,
            })
        })
        .collect();
    json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "type": "result",
        "protocol_version": snapshot.protocol_version,
        "sequence_number": snapshot.sequence_number,
        "timestamp": snapshot.timestamp,
        "network_id": snapshot.network_id.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "base_reserve": snapshot.base_reserve,
        "min_persistent_entry_ttl": snapshot.min_persistent_entry_ttl,
        "min_temp_entry_ttl": snapshot.min_temp_entry_ttl,
        "max_entry_ttl": snapshot.max_entry_ttl,
        "entries": entries,
    })
}

#[cfg(not(feature = "lane-p28"))]
fn read(id: &Value, _text: &str) -> Value {
    error_message(
        id,
        "unsupported_ledger_protocol",
        "this simulator was built without the protocol 28 lane, which reads ledger snapshots"
            .into(),
        json!({ "kind": "ledger_protocol", "requested": 28 }),
    )
}
