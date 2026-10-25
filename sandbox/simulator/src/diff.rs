//! `diff_results` (#568): what changed between a call on the deployed code
//! (A) and on the new build (B). The values (return, events, storage, auth)
//! are compared in the lane, as XDR; the outcome and the resources here.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::{DiffSide, DiffWrite};
use crate::ledger::verbs::OpenLedger;
use crate::xdr_helpers::lane_for;
use crate::PROTOCOL_VERSION;

/// The resources compared, in report order.
pub const METRICS: [&str; 7] = [
    "instructions",
    "mem_bytes",
    "read_bytes",
    "write_bytes",
    "read_entries",
    "write_entries",
    "resource_fee",
];

fn invalid_field(id: &Value, path: &str, expected: &str) -> Value {
    error_message(
        id,
        "bad_request",
        format!("`{path}` must be {expected}"),
        json!({ "kind": "invalid_field", "path": path, "expected": expected }),
    )
}

/// One side as the request gives it.
struct Side {
    /// `None` for a call that returned; the error's kind and code otherwise.
    error: Option<(String, String)>,
    values: DiffSide,
    resources: Map<String, Value>,
}

impl Side {
    fn outcome(&self) -> String {
        match &self.error {
            None => "ok".to_string(),
            Some((kind, code)) => format!("{kind} error {code}"),
        }
    }
}

fn b64(id: &Value, path: &str, value: Option<&Value>) -> Result<Vec<u8>, Value> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .and_then(|s| BASE64.decode(s).ok())
        .ok_or_else(|| invalid_field(id, path, "base64 XDR"))
}

fn list<'a>(
    id: &Value,
    object: &'a Map<String, Value>,
    path: &str,
    field: &str,
) -> Result<&'a [Value], Value> {
    match object.get(field) {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(invalid_field(id, &format!("{path}.{field}"), "an array")),
    }
}

fn side(id: &Value, object: &Map<String, Value>, name: &str) -> Result<Side, Value> {
    let Some(Value::Object(s)) = object.get(name) else {
        return Err(invalid_field(id, name, "an object"));
    };
    let error = match s.get("outcome").and_then(Value::as_str) {
        Some("ok") => None,
        Some("error") => {
            let field = |f: &str| {
                s.get("error")
                    .and_then(|e| e.get(f))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| invalid_field(id, &format!("{name}.error.{f}"), "a string"))
            };
            Some((field("kind")?, field("code")?))
        }
        _ => {
            return Err(invalid_field(
                id,
                &format!("{name}.outcome"),
                "\"ok\" or \"error\"",
            ))
        }
    };
    let mut values = DiffSide::default();
    if error.is_none() {
        values.return_value = Some(b64(
            id,
            &format!("{name}.return_value_xdr"),
            s.get("return_value_xdr"),
        )?);
    }
    for (i, event) in list(id, s, name, "events")?.iter().enumerate() {
        if event.get("type").and_then(Value::as_str) == Some("diagnostic") {
            continue;
        }
        values.events.push(b64(
            id,
            &format!("{name}.events[{i}].event_xdr"),
            event.get("event_xdr"),
        )?);
    }
    for (i, write) in list(id, s, name, "storage")?.iter().enumerate() {
        let at = |f: &str| format!("{name}.storage[{i}].{f}");
        let entry_xdr = match write.get("entry_xdr") {
            None | Some(Value::Null) => None,
            v => Some(b64(id, &at("entry_xdr"), v)?),
        };
        let live_until =
            match write.get("live_until_ledger") {
                None | Some(Value::Null) => None,
                Some(v) => Some(v.as_u64().and_then(|n| u32::try_from(n).ok()).ok_or_else(
                    || invalid_field(id, &at("live_until_ledger"), "a ledger sequence"),
                )?),
            };
        values.writes.push(DiffWrite {
            key_xdr: b64(id, &at("key_xdr"), write.get("key_xdr"))?,
            entry_xdr,
            live_until,
        });
    }
    for (i, entry) in list(id, s, name, "auth")?.iter().enumerate() {
        values
            .auth
            .push(b64(id, &format!("{name}.auth[{i}]"), Some(entry))?);
    }
    let resources = match s.get("resources") {
        None => Map::new(),
        Some(Value::Object(r)) => {
            for (metric, v) in r {
                if !METRICS.contains(&metric.as_str()) {
                    return Err(invalid_field(
                        id,
                        &format!("{name}.resources"),
                        &format!("keyed by {}", METRICS.join(", ")),
                    ));
                }
                if !v.is_u64() && !v.is_i64() {
                    return Err(invalid_field(
                        id,
                        &format!("{name}.resources.{metric}"),
                        "an integer",
                    ));
                }
            }
            r.clone()
        }
        Some(_) => return Err(invalid_field(id, &format!("{name}.resources"), "an object")),
    };
    Ok(Side {
        error,
        values,
        resources,
    })
}

/// Each metric both sides report that moved: absolute and, when A's is not
/// zero, as a percentage of A's, to one decimal.
fn resources(a: &Map<String, Value>, b: &Map<String, Value>) -> Vec<Value> {
    METRICS
        .iter()
        .filter_map(|metric| {
            let (x, y) = (a.get(*metric)?.as_i64()?, b.get(*metric)?.as_i64()?);
            if x == y {
                return None;
            }
            let percent = (x != 0).then(|| ((y - x) as f64 * 1000.0 / x as f64).round() / 10.0);
            Some(json!({ "metric": metric, "a": x, "b": y, "delta": y - x, "percent": percent }))
        })
        .collect()
}

fn no_changes() -> Value {
    json!({
        "return_value": null,
        "events": { "added": [], "removed": [], "changed": [] },
        "storage": { "added": [], "removed": [], "changed": [], "ttl": [] },
        "auth": { "client_breaking": false, "added": [], "removed": [], "changed": [] },
    })
}

fn lists_empty(value: &Value) -> bool {
    value
        .as_object()
        .is_none_or(|o| o.values().all(|v| v.as_array().is_none_or(Vec::is_empty)))
}

/// `diff_results`: compare A and B. When the outcome differs (one side
/// returned, the other failed, or they failed differently) that is the
/// difference; the values are compared only when both returned.
pub fn diff_results(ledger: &Option<OpenLedger>, id: &Value, object: &Map<String, Value>) -> Value {
    let lane = match lane_for(ledger, id, object) {
        Ok(lane) => lane,
        Err(error) => return error,
    };
    let (a, b) = match (side(id, object, "a"), side(id, object, "b")) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => return e,
    };
    let outcome = if a.error == b.error {
        Value::Null
    } else {
        json!({ "a": a.outcome(), "b": b.outcome() })
    };
    let mut values = if a.error.is_none() && b.error.is_none() {
        match lane.diff_values(&a.values, &b.values) {
            Ok(values) => values,
            Err(e) => {
                return error_message(
                    id,
                    "bad_request",
                    format!("a side does not decode: {e}"),
                    json!({ "kind": "invalid_field", "path": "a|b", "reason": e.to_string() }),
                )
            }
        }
    } else {
        no_changes()
    };
    let resources = resources(&a.resources, &b.resources);
    let empty = outcome.is_null()
        && values["return_value"].is_null()
        && ["events", "storage", "auth"]
            .iter()
            .all(|k| lists_empty(&values[*k]))
        && resources.is_empty();
    values["version"] = json!(PROTOCOL_VERSION);
    values["id"] = id.clone();
    values["type"] = json!("result");
    values["empty"] = json!(empty);
    values["outcome"] = outcome;
    values["resources"] = Value::Array(resources);
    values
}
