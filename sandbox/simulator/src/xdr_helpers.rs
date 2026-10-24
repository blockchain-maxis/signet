//! The XDR helper verbs (#532): `xdr_keys`, `tx_decode` and `wasm_inspect`.
//!
//! Go never parses XDR (docs/CLI_RUST_BRIDGE.md §2). These verbs answer the
//! three things it still needs to know: which ledger keys to ask RPC for, what
//! a transaction on chain called, and what an executable declares. Like the
//! ledger verbs, they hold XDR only as bytes and leave decoding to a lane.
//!
//! None of them needs an open ledger. They decode with the lane named by an
//! optional `ledger_protocol`, else the open ledger's lane, else the newest.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::{KeyRequest, Lane, LaneError, LaneRegistry};
use crate::ledger::verbs::{unsupported_ledger_protocol, OpenLedger};
use crate::PROTOCOL_VERSION;

fn invalid_field(id: &Value, path: &str, expected: &str) -> Value {
    error_message(
        id,
        "bad_request",
        format!("`{path}` must be {expected}"),
        json!({ "kind": "invalid_field", "path": path, "expected": expected }),
    )
}

/// [`invalid_field`] with the lane's reason attached, for input that is the
/// right type but does not decode.
fn undecodable(id: &Value, path: &str, expected: &str, error: &LaneError) -> Value {
    error_message(
        id,
        "bad_request",
        format!("`{path}` must be {expected}: {error}"),
        json!({
            "kind": "invalid_field",
            "path": path,
            "expected": expected,
            "reason": error.to_string(),
        }),
    )
}

fn result(id: &Value, fields: Value) -> Value {
    let mut reply = json!({ "version": PROTOCOL_VERSION, "id": id, "type": "result" });
    if let (Value::Object(reply), Value::Object(fields)) = (&mut reply, fields) {
        reply.extend(fields);
    }
    reply
}

/// The lane a helper decodes with.
fn lane_for(
    ledger: &Option<OpenLedger>,
    id: &Value,
    object: &Map<String, Value>,
) -> Result<&'static dyn Lane, Value> {
    let registry = LaneRegistry::builtin();
    match object.get("ledger_protocol") {
        None => Ok(ledger
            .as_ref()
            .map_or_else(|| registry.newest(), |open| open.lane)),
        Some(value) => {
            let Some(protocol) = value.as_u64() else {
                return Err(invalid_field(id, "ledger_protocol", "an integer"));
            };
            let protocol = u32::try_from(protocol).unwrap_or(u32::MAX);
            registry
                .for_protocol(protocol)
                .map_err(|unsupported| unsupported_ledger_protocol(id, &unsupported))
        }
    }
}

fn required_str<'a>(
    id: &Value,
    object: &'a Map<String, Value>,
    path: &str,
    field: &str,
) -> Result<&'a str, Value> {
    match object.get(field).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(invalid_field(id, path, "a non-empty string")),
    }
}

fn decode_b64(id: &Value, path: &str, value: &str) -> Result<Vec<u8>, Value> {
    BASE64
        .decode(value)
        .map_err(|_| invalid_field(id, path, "base64"))
}

fn parse_hash(id: &Value, path: &str, value: &str) -> Result<[u8; 32], Value> {
    let bad = || invalid_field(id, path, "64 lowercase hex digits");
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(bad());
    }
    let mut hash = [0u8; 32];
    for (i, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[2 * i..2 * i + 2], 16).map_err(|_| bad())?;
    }
    Ok(hash)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The field a lane's refusal of a key request points at, and what that field
/// must be; `None` when the request has no field a lane could refuse.
type RefusalField = Option<(String, &'static str)>;

/// One `keys[]` item as a [`KeyRequest`], and the field a lane's refusal of it
/// points at.
fn key_request(
    id: &Value,
    index: usize,
    item: &Value,
) -> Result<(KeyRequest, RefusalField), Value> {
    let at = format!("keys[{index}]");
    let Some(item) = item.as_object() else {
        return Err(invalid_field(id, &at, "an object"));
    };
    let Some(kind) = item.get("kind").and_then(Value::as_str) else {
        return Err(invalid_field(id, &format!("{at}.kind"), "a string"));
    };
    let field = |name: &str| format!("{at}.{name}");
    Ok(match kind {
        "contract_instance" => (
            KeyRequest::ContractInstance {
                contract_id: required_str(id, item, &field("contract_id"), "contract_id")?
                    .to_string(),
            },
            Some((field("contract_id"), "a contract strkey (C...)")),
        ),
        "contract_code" => {
            let path = field("wasm_hash");
            let hash = required_str(id, item, &path, "wasm_hash")?;
            (
                KeyRequest::ContractCode {
                    wasm_hash: parse_hash(id, &path, hash)?,
                },
                None,
            )
        }
        "account" => (
            KeyRequest::Account {
                account_id: required_str(id, item, &field("account_id"), "account_id")?.to_string(),
            },
            Some((field("account_id"), "an account strkey (G...)")),
        ),
        "config_setting" => (
            KeyRequest::ConfigSetting {
                setting: required_str(id, item, &field("setting"), "setting")?.to_string(),
            },
            Some((field("setting"), "a ConfigSettingId name")),
        ),
        "network_config" => (KeyRequest::NetworkConfig, None),
        _ => {
            return Err(invalid_field(
                id,
                &field("kind"),
                "one of contract_instance, contract_code, account, config_setting, network_config",
            ))
        }
    })
}

/// `xdr_keys`: the base64 `LedgerKey` for each entry named in `keys[]`, in
/// request order; a `network_config` item expands to one key per setting.
pub fn xdr_keys(ledger: &Option<OpenLedger>, id: &Value, object: &Map<String, Value>) -> Value {
    let lane = match lane_for(ledger, id, object) {
        Ok(lane) => lane,
        Err(error) => return error,
    };
    let Some(items) = object.get("keys").and_then(Value::as_array) else {
        return invalid_field(id, "keys", "an array");
    };
    if items.is_empty() {
        return invalid_field(id, "keys", "a non-empty array");
    }

    let mut keys = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let (request, refusal_path) = match key_request(id, index, item) {
            Ok(parsed) => parsed,
            Err(error) => return error,
        };
        let derived = match lane.ledger_keys(&request) {
            Ok(derived) => derived,
            Err(error) => {
                let (path, expected) = refusal_path
                    .unwrap_or_else(|| (format!("keys[{index}]"), "a key this lane can build"));
                return undecodable(id, &path, expected, &error);
            }
        };
        keys.extend(derived.into_iter().map(|key| {
            json!({
                "kind": key.kind,
                "subject": key.subject,
                "key_xdr": BASE64.encode(key.key_xdr),
            })
        }));
    }
    result(id, json!({ "keys": keys }))
}

/// `tx_decode`: a transaction envelope, and optionally the meta RPC returned
/// for it, as JSON.
pub fn tx_decode(ledger: &Option<OpenLedger>, id: &Value, object: &Map<String, Value>) -> Value {
    let lane = match lane_for(ledger, id, object) {
        Ok(lane) => lane,
        Err(error) => return error,
    };
    let envelope = match required_str(id, object, "transaction_xdr", "transaction_xdr")
        .and_then(|text| decode_b64(id, "transaction_xdr", text))
    {
        Ok(bytes) => bytes,
        Err(error) => return error,
    };
    let meta = match object.get("result_meta_xdr") {
        None | Some(Value::Null) => None,
        Some(_) => match required_str(id, object, "result_meta_xdr", "result_meta_xdr")
            .and_then(|text| decode_b64(id, "result_meta_xdr", text))
        {
            Ok(bytes) => Some(bytes),
            Err(error) => return error,
        },
    };

    match lane.decode_transaction(&envelope, meta.as_deref()) {
        Ok(transaction) => result(id, json!({ "transaction": transaction })),
        Err(error @ LaneError::InvalidXdr { what, .. }) if what.starts_with("TransactionMeta") => {
            undecodable(id, "result_meta_xdr", "a base64 TransactionMeta", &error)
        }
        Err(error) => undecodable(
            id,
            "transaction_xdr",
            "a base64 TransactionEnvelope",
            &error,
        ),
    }
}

/// `wasm_inspect`: what an executable declares, without running it.
pub fn wasm_inspect(ledger: &Option<OpenLedger>, id: &Value, object: &Map<String, Value>) -> Value {
    let lane = match lane_for(ledger, id, object) {
        Ok(lane) => lane,
        Err(error) => return error,
    };
    let wasm = match required_str(id, object, "wasm_base64", "wasm_base64")
        .and_then(|text| decode_b64(id, "wasm_base64", text))
    {
        Ok(bytes) => bytes,
        Err(error) => return error,
    };
    let inspection = match lane.inspect_wasm(&wasm) {
        Ok(inspection) => inspection,
        Err(error) => return undecodable(id, "wasm_base64", "a WASM module", &error),
    };
    result(
        id,
        json!({
            "wasm_hash": hex(&inspection.wasm_hash),
            "size_bytes": inspection.size_bytes,
            "custom_sections": inspection.custom_sections,
            "interface_version": inspection.interface_version.map(|v| json!({
                "protocol": v.protocol,
                "pre_release": v.pre_release,
            })),
            "exports": inspection.exports,
            "imports": inspection
                .imports
                .iter()
                .map(|(module, name)| json!({ "module": module, "name": name }))
                .collect::<Vec<_>>(),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn kind_and_path(reply: &Value) -> (&str, &str) {
        (
            reply["detail"]["kind"].as_str().unwrap_or_default(),
            reply["detail"]["path"].as_str().unwrap_or_default(),
        )
    }

    #[test]
    fn a_hash_must_be_64_lowercase_hex_digits() {
        let id = json!("r1");
        assert_eq!(parse_hash(&id, "h", &"ab".repeat(32)).unwrap(), [0xab; 32]);
        assert!(parse_hash(&id, "h", &"AB".repeat(32)).is_err());
        assert!(parse_hash(&id, "h", "abcd").is_err());
    }

    #[test]
    fn an_unknown_key_kind_names_the_field() {
        let reply = xdr_keys(
            &None,
            &json!("r1"),
            &object(json!({ "keys": [{ "kind": "trustline" }] })),
        );
        assert_eq!(kind_and_path(&reply), ("invalid_field", "keys[0].kind"));
    }

    #[test]
    fn a_bad_strkey_points_at_its_field() {
        let reply = xdr_keys(
            &None,
            &json!("r1"),
            &object(json!({ "keys": [
                { "kind": "account", "account_id": "GCWEY5SG6LEGTI6MJ7BTS5FF22DDBZN3E6BS4AFFB44BNOAE4A5V4PWE" },
                { "kind": "contract_instance", "contract_id": "not-a-strkey" },
            ] })),
        );
        assert_eq!(
            kind_and_path(&reply),
            ("invalid_field", "keys[1].contract_id")
        );
        assert!(reply["detail"]["reason"].is_string(), "{reply}");
    }

    #[test]
    fn an_unsupported_protocol_is_the_catalogue_error() {
        let reply = wasm_inspect(
            &None,
            &json!("r1"),
            &object(json!({ "ledger_protocol": 9, "wasm_base64": "AGFzbQEAAAA=" })),
        );
        assert_eq!(reply["code"], "unsupported_ledger_protocol");
    }

    #[test]
    fn junk_envelope_and_meta_are_attributed_to_their_fields() {
        let id = json!("r1");
        let reply = tx_decode(&None, &id, &object(json!({ "transaction_xdr": "AAAA" })));
        assert_eq!(kind_and_path(&reply), ("invalid_field", "transaction_xdr"));
        let reply = tx_decode(
            &None,
            &id,
            &object(json!({ "transaction_xdr": "not base64!" })),
        );
        assert_eq!(kind_and_path(&reply), ("invalid_field", "transaction_xdr"));
    }
}
