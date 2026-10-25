//! `diff_results` (#568): what changed between a call on the deployed code
//! (A) and on the new build (B). The values (return, events, storage, auth)
//! are compared in the lane, as XDR; the outcome and the resources here.
//!
//! `rules` (#569, `[diff]` in signet.dev.toml) classify each difference:
//! `breaking` (outcome, return value, storage, auth), `behavioural`
//! (events), `cost` (a resource beyond its tolerance) or `ignored` (an
//! ignored event prefix or storage key, auth under `ignore_auth`, a
//! resource within tolerance). Ignored differences are still listed and
//! counted, so nothing is hidden silently.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::dispatch::error_message;
use crate::lanes::{ByteSnapshotSource, DiffRules, DiffSide, DiffWrite};
use crate::ledger::verbs::OpenLedger;
use crate::spec_verbs::wasm_of_contract;
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

/// How far a metric may move before it counts as `cost`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Tolerance {
    Percent(f64),
    Absolute(i64),
}

/// The request's `rules`, parsed.
#[derive(Default)]
struct Rules {
    lane: DiffRules,
    contract_id: Option<String>,
    ignore_auth: bool,
    tolerance: Vec<(String, Tolerance)>,
}

fn rules(id: &Value, object: &Map<String, Value>) -> Result<Rules, Value> {
    let Some(raw) = object.get("rules") else {
        return Ok(Rules::default());
    };
    let Value::Object(r) = raw else {
        return Err(invalid_field(id, "rules", "an object"));
    };
    let mut out = Rules::default();
    let strings = |field: &str| -> Result<Vec<String>, Value> {
        match r.get(field) {
            None => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .enumerate()
                .map(|(i, v)| {
                    v.as_str()
                        .filter(|s| !s.trim().is_empty())
                        .map(str::to_string)
                        .ok_or_else(|| {
                            invalid_field(id, &format!("rules.{field}[{i}]"), "a non-empty string")
                        })
                })
                .collect(),
            Some(_) => Err(invalid_field(
                id,
                &format!("rules.{field}"),
                "an array of strings",
            )),
        }
    };
    for (i, prefix) in strings("ignore_events")?.into_iter().enumerate() {
        let topics: Vec<String> = prefix.split('/').map(str::to_string).collect();
        if topics.iter().any(String::is_empty) {
            return Err(invalid_field(
                id,
                &format!("rules.ignore_events[{i}]"),
                "topics separated by /, none empty",
            ));
        }
        out.lane.ignore_events.push(topics);
    }
    out.lane.ignore_storage = strings("ignore_storage")?;
    out.ignore_auth = match r.get("ignore_auth") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid_field(id, "rules.ignore_auth", "a boolean")),
    };
    out.contract_id = match r.get("contract_id") {
        None => None,
        Some(Value::String(c)) if !c.is_empty() => Some(c.clone()),
        Some(_) => {
            return Err(invalid_field(
                id,
                "rules.contract_id",
                "a contract id (C...)",
            ))
        }
    };
    match r.get("resource_tolerance") {
        None => {}
        Some(Value::Object(t)) => {
            for (metric, v) in t {
                let at = format!("rules.resource_tolerance.{metric}");
                if !METRICS.contains(&metric.as_str()) {
                    return Err(invalid_field(
                        id,
                        "rules.resource_tolerance",
                        &format!("keyed by {}", METRICS.join(", ")),
                    ));
                }
                let tolerance = match (
                    v.get("percent").and_then(Value::as_f64),
                    v.get("absolute").and_then(Value::as_i64),
                ) {
                    (Some(p), None) if p >= 0.0 => Tolerance::Percent(p),
                    (None, Some(n)) if n >= 0 => Tolerance::Absolute(n),
                    _ => {
                        return Err(invalid_field(
                            id,
                            &at,
                            "{\"percent\": n} or {\"absolute\": n}, not negative",
                        ))
                    }
                };
                out.tolerance.push((metric.clone(), tolerance));
            }
        }
        Some(_) => return Err(invalid_field(id, "rules.resource_tolerance", "an object")),
    }
    Ok(out)
}

/// Each metric both sides report that moved: absolute and, when A's is not
/// zero, as a percentage of A's, to one decimal; `cost`, or `ignored` when
/// within the metric's tolerance.
fn resources(a: &Map<String, Value>, b: &Map<String, Value>, rules: &Rules) -> Vec<Value> {
    METRICS
        .iter()
        .filter_map(|metric| {
            let (x, y) = (a.get(*metric)?.as_i64()?, b.get(*metric)?.as_i64()?);
            if x == y {
                return None;
            }
            let percent = (x != 0).then(|| ((y - x) as f64 * 1000.0 / x as f64).round() / 10.0);
            let within = rules
                .tolerance
                .iter()
                .find(|(m, _)| m == metric)
                .is_some_and(|(_, t)| match *t {
                    Tolerance::Percent(p) => percent.is_some_and(|q| q.abs() <= p),
                    Tolerance::Absolute(n) => (y - x).abs() <= n,
                });
            let class = if within { "ignored" } else { "cost" };
            Some(json!({ "metric": metric, "a": x, "b": y, "delta": y - x, "percent": percent, "class": class }))
        })
        .collect()
}

/// Every difference counted by class.
fn summary(values: &Value) -> Value {
    let mut counts: Map<String, Value> = ["breaking", "behavioural", "cost", "ignored"]
        .iter()
        .map(|c| (c.to_string(), json!(0)))
        .collect();
    let mut count = |item: &Value| {
        if let Some(class) = item.get("class").and_then(Value::as_str) {
            if let Some(n) = counts.get_mut(class) {
                *n = json!(n.as_u64().unwrap_or(0) + 1);
            }
        }
    };
    for single in ["outcome", "return_value"] {
        if !values[single].is_null() {
            count(&values[single]);
        }
    }
    for group in ["events", "storage", "auth"] {
        if let Some(lists) = values[group].as_object() {
            lists
                .values()
                .filter_map(Value::as_array)
                .flatten()
                .for_each(&mut count);
        }
    }
    values["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .for_each(&mut count);
    Value::Object(counts)
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
pub fn diff_results(
    ledger: &Option<OpenLedger>,
    fork: Option<&dyn ByteSnapshotSource>,
    id: &Value,
    object: &Map<String, Value>,
) -> Value {
    let lane = match lane_for(ledger, id, object) {
        Ok(lane) => lane,
        Err(error) => return error,
    };
    let mut rules = match rules(id, object) {
        Ok(rules) => rules,
        Err(error) => return error,
    };
    // `ignore_storage` reads enum cases by the contract's spec.
    if let Some(contract) = &rules.contract_id {
        let Some(fork) = fork else {
            return invalid_field(
                id,
                "rules.contract_id",
                "a contract in an open ledger (send ledger_open first)",
            );
        };
        match wasm_of_contract(fork, lane, contract) {
            Ok(wasm) => rules.lane.spec_wasm = Some(wasm),
            Err(reason) => {
                return error_message(
                    id,
                    "bad_request",
                    format!("`rules.contract_id`: {reason}"),
                    json!({ "kind": "invalid_field", "path": "rules.contract_id", "reason": reason }),
                )
            }
        }
    }
    let (a, b) = match (side(id, object, "a"), side(id, object, "b")) {
        (Ok(a), Ok(b)) => (a, b),
        (Err(e), _) | (_, Err(e)) => return e,
    };
    let outcome = if a.error == b.error {
        Value::Null
    } else {
        json!({ "a": a.outcome(), "b": b.outcome(), "class": "breaking" })
    };
    let mut values = if a.error.is_none() && b.error.is_none() {
        match lane.diff_values(&a.values, &b.values, &rules.lane) {
            Ok(values) => values,
            Err(e @ crate::lanes::LaneError::Argument { .. }) => {
                return error_message(
                    id,
                    "bad_request",
                    format!("an ignore_storage pattern does not read: {e}"),
                    json!({ "kind": "invalid_field", "path": "rules.ignore_storage", "reason": e.to_string() }),
                )
            }
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
    if rules.ignore_auth {
        for list in ["added", "removed", "changed"] {
            for item in values["auth"][list].as_array_mut().into_iter().flatten() {
                item["class"] = json!("ignored");
            }
        }
    }
    let resources = resources(&a.resources, &b.resources, &rules);
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
    values["summary"] = summary(&values);
    values
}
