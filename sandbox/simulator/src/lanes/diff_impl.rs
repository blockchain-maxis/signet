//! The A/B diff of a call's values (#568): its return value, events,
//! storage writes and auth, compared as the `ScVal`s and entries the host
//! produced. Comparing decoded JSON would take `u64` 1 for `i128` 1; here
//! the types are part of the value, and a difference is reported at the
//! JSON pointer of the first place two values part, with both sides in
//! `scval_json`'s tagged form, which keeps the types visible.
//!
//! Outcome and resources are compared outside the lane (`diff.rs`): they
//! are not XDR.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::soroban_env_host::xdr::{
    ContractEvent, ContractEventBody, LedgerEntry, LedgerEntryData, LedgerKey, ScContractInstance,
    ScMap, ScVal, SorobanAuthorizationEntry, SorobanAuthorizedFunction,
    SorobanAuthorizedInvocation, SorobanCredentials,
};
use super::spec::KeyPattern;
use super::{decode, event_json, scval_json, DiffSide, DiffWrite, LaneError};

/// What a diff leaves out (#569), read for this lane: event topic prefixes,
/// and storage key patterns.
pub struct Rules<'a> {
    pub events: &'a [Vec<String>],
    pub storage: &'a [KeyPattern],
}

impl Rules<'_> {
    fn ignores_key(&self, key: &ScVal) -> bool {
        self.storage.iter().any(|p| p.matches(key))
    }

    /// Whether an event's first topics read as one of the prefixes: a
    /// symbol or string by its text, an address by its strkey, a number by
    /// its digits.
    fn ignores_event(&self, event: &ContractEvent) -> bool {
        let topics = body(event).0;
        self.events.iter().any(|prefix| {
            prefix.len() <= topics.len()
                && prefix
                    .iter()
                    .zip(topics)
                    .all(|(want, topic)| topic_text(topic) == *want)
        })
    }
}

fn topic_text(topic: &ScVal) -> String {
    match topic {
        ScVal::Symbol(s) => s.0.to_utf8_string_lossy(),
        ScVal::String(s) => s.0.to_utf8_string_lossy(),
        ScVal::Address(a) => a.to_string(),
        ScVal::U32(n) => n.to_string(),
        ScVal::I32(n) => n.to_string(),
        other => scval_json(other).map_or_else(|_| String::new(), |v| v.to_string()),
    }
}

/// An instance with the ignored keys taken out of its storage map.
fn without_ignored(instance: &ScContractInstance, rules: &Rules) -> ScVal {
    let kept = instance.storage.as_ref().map(|map| {
        let entries: Vec<_> = map
            .iter()
            .filter(|e| !rules.ignores_key(&e.key))
            .cloned()
            .collect();
        ScMap(entries.try_into().unwrap_or_default())
    });
    ScVal::Map(kept)
}

/// The key a written entry is stored under, for `ignore_storage`: a
/// contract-data key, not an instance's.
fn data_key(key_xdr: &[u8]) -> Option<ScVal> {
    match decode::<LedgerKey>(key_xdr, "LedgerKey").ok()? {
        LedgerKey::ContractData(d) if d.key != ScVal::LedgerKeyContractInstance => Some(d.key),
        _ => None,
    }
}

/// Where two values first differ, and what each side holds there (`null`
/// where a side has nothing: a missing vec item, map key or field).
struct Difference {
    path: String,
    a: Value,
    b: Value,
}

impl Difference {
    fn json(self) -> Value {
        json!({ "path": self.path, "a": self.a, "b": self.b })
    }
}

/// A JSON pointer segment (RFC 6901): `~` and `/` escaped.
fn segment(raw: &str) -> String {
    raw.replace('~', "~0").replace('/', "~1")
}

/// A map key as a pointer segment: a symbol or string by its text, a
/// number by its digits, anything else by its tagged JSON.
fn key_segment(key: &ScVal) -> Result<String, LaneError> {
    Ok(segment(&match key {
        ScVal::Symbol(s) => s.0.to_utf8_string_lossy(),
        ScVal::String(s) => s.0.to_utf8_string_lossy(),
        ScVal::U32(n) => n.to_string(),
        ScVal::I32(n) => n.to_string(),
        other => scval_json(other)?.to_string(),
    }))
}

fn optional(value: Option<&ScVal>) -> Result<Value, LaneError> {
    value.map_or(Ok(Value::Null), scval_json)
}

/// The first place `a` and `b` differ, depth first: into vecs by index and
/// maps by key while both sides have the same shape, and at the value
/// itself once they do not (another type, another scalar).
fn first_difference(a: &ScVal, b: &ScVal, path: &str) -> Result<Option<Difference>, LaneError> {
    if a == b {
        return Ok(None);
    }
    match (a, b) {
        // An instance is compared by its storage map. Its executable is
        // left out: B's is the new build by construction (the swap), and
        // a write to instance storage carries it.
        (ScVal::ContractInstance(ia), ScVal::ContractInstance(ib)) => first_difference(
            &ScVal::Map(ia.storage.clone()),
            &ScVal::Map(ib.storage.clone()),
            &format!("{path}/storage"),
        ),
        (ScVal::Vec(Some(va)), ScVal::Vec(Some(vb))) => {
            for (i, (x, y)) in va.iter().zip(vb.iter()).enumerate() {
                if let Some(d) = first_difference(x, y, &format!("{path}/{i}"))? {
                    return Ok(Some(d));
                }
            }
            let i = va.len().min(vb.len());
            Ok(Some(Difference {
                path: format!("{path}/{i}"),
                a: optional(va.get(i))?,
                b: optional(vb.get(i))?,
            }))
        }
        (ScVal::Map(Some(ma)), ScVal::Map(Some(mb))) => {
            for entry in ma.iter() {
                let at = format!("{path}/{}", key_segment(&entry.key)?);
                match mb.iter().find(|other| other.key == entry.key) {
                    Some(other) => {
                        if let Some(d) = first_difference(&entry.val, &other.val, &at)? {
                            return Ok(Some(d));
                        }
                    }
                    None => {
                        return Ok(Some(Difference {
                            path: at,
                            a: scval_json(&entry.val)?,
                            b: Value::Null,
                        }))
                    }
                }
            }
            for entry in mb.iter() {
                if !ma.iter().any(|other| other.key == entry.key) {
                    return Ok(Some(Difference {
                        path: format!("{path}/{}", key_segment(&entry.key)?),
                        a: Value::Null,
                        b: scval_json(&entry.val)?,
                    }));
                }
            }
            // The same entries in another order: a host map is sorted, so
            // this is not expected, but it is still a difference.
            whole(a, b, path)
        }
        _ => whole(a, b, path),
    }
}

fn whole(a: &ScVal, b: &ScVal, path: &str) -> Result<Option<Difference>, LaneError> {
    Ok(Some(Difference {
        path: path.to_string(),
        a: scval_json(a)?,
        b: scval_json(b)?,
    }))
}

/// [`first_difference`] over plain JSON, for values the lane has already
/// rendered (auth invocation trees).
fn json_difference(a: &Value, b: &Value, path: &str) -> Option<Difference> {
    if a == b {
        return None;
    }
    match (a, b) {
        (Value::Array(xa), Value::Array(xb)) => {
            for (i, (x, y)) in xa.iter().zip(xb).enumerate() {
                if let Some(d) = json_difference(x, y, &format!("{path}/{i}")) {
                    return Some(d);
                }
            }
            let i = xa.len().min(xb.len());
            Some(Difference {
                path: format!("{path}/{i}"),
                a: xa.get(i).cloned().unwrap_or(Value::Null),
                b: xb.get(i).cloned().unwrap_or(Value::Null),
            })
        }
        (Value::Object(oa), Value::Object(ob)) => {
            // serde_json's maps are sorted, so keys come in a stable order.
            let mut keys: Vec<&String> = oa.keys().chain(ob.keys()).collect();
            keys.sort();
            keys.dedup();
            keys.into_iter().find_map(|k| {
                let at = format!("{path}/{}", segment(k));
                match (oa.get(k), ob.get(k)) {
                    (Some(x), Some(y)) => json_difference(x, y, &at),
                    (x, y) => Some(Difference {
                        path: at,
                        a: x.cloned().unwrap_or(Value::Null),
                        b: y.cloned().unwrap_or(Value::Null),
                    }),
                }
            })
        }
        _ => Some(Difference {
            path: path.to_string(),
            a: a.clone(),
            b: b.clone(),
        }),
    }
}

/// Both sides' values compared: `return_value` (null when equal), and
/// `events`, `storage` and `auth`, each with empty lists when equal.
pub fn values(
    a: &DiffSide,
    b: &DiffSide,
    rules: &Rules,
    describe_key: &dyn Fn(&[u8]) -> String,
    describe_entry: &dyn Fn(&[u8]) -> Result<Value, LaneError>,
) -> Result<Value, LaneError> {
    let return_value = match (&a.return_value, &b.return_value) {
        (Some(x), Some(y)) => {
            let (x, y): (ScVal, ScVal) = (decode(x, "ScVal")?, decode(y, "ScVal")?);
            first_difference(&x, &y, "")?.map_or(Value::Null, |d| {
                let mut v = d.json();
                v["class"] = json!("breaking");
                v
            })
        }
        _ => Value::Null,
    };
    Ok(json!({
        "return_value": return_value,
        "events": events(&a.events, &b.events, rules)?,
        "storage": storage(&a.writes, &b.writes, rules, describe_key, describe_entry)?,
        "auth": auth(&a.auth, &b.auth)?,
    }))
}

fn decode_events(events: &[Vec<u8>]) -> Result<Vec<ContractEvent>, LaneError> {
    events.iter().map(|e| decode(e, "ContractEvent")).collect()
}

fn body(event: &ContractEvent) -> (&[ScVal], &ScVal) {
    let ContractEventBody::V0(body) = &event.body;
    (body.topics.as_slice(), &body.data)
}

/// Events by index: at an index where both sides have an event with the
/// same emitter, type and topics, a different payload is `changed` (the
/// first difference in its data); anything else there is `removed` (A's)
/// and `added` (B's). Each is `behavioural`, or `ignored` when its topics
/// start with an `ignore_events` prefix.
fn events(a: &[Vec<u8>], b: &[Vec<u8>], rules: &Rules) -> Result<Value, LaneError> {
    let (ea, eb) = (decode_events(a)?, decode_events(b)?);
    let class = |e: &ContractEvent| {
        if rules.ignores_event(e) {
            "ignored"
        } else {
            "behavioural"
        }
    };
    let (mut added, mut removed, mut changed) = (Vec::new(), Vec::new(), Vec::new());
    for i in 0..ea.len().max(eb.len()) {
        match (ea.get(i), eb.get(i)) {
            (Some(x), Some(y)) if x == y => {}
            (Some(x), Some(y))
                if x.contract_id == y.contract_id
                    && x.type_ == y.type_
                    && body(x).0 == body(y).0 =>
            {
                let d = first_difference(body(x).1, body(y).1, "/data")?.unwrap_or_else(|| {
                    Difference {
                        path: String::new(),
                        a: Value::Null,
                        b: Value::Null,
                    }
                });
                let topics: Vec<Value> =
                    body(x).0.iter().map(scval_json).collect::<Result<_, _>>()?;
                changed.push(json!({
                    "index": i,
                    "topics": topics,
                    "path": d.path,
                    "a": d.a,
                    "b": d.b,
                    "class": class(x),
                }));
            }
            (x, y) => {
                if let Some(x) = x {
                    removed.push(json!({ "index": i, "event": event_json(x)?, "class": class(x) }));
                }
                if let Some(y) = y {
                    added.push(json!({ "index": i, "event": event_json(y)?, "class": class(y) }));
                }
            }
        }
    }
    Ok(json!({ "added": added, "removed": removed, "changed": changed }))
}

/// A contract-data entry's value, the part of an entry a path goes into.
fn data_value(entry: &LedgerEntry) -> Option<&ScVal> {
    match &entry.data {
        LedgerEntryData::ContractData(data) => Some(&data.val),
        _ => None,
    }
}

/// Writes by ledger key, in key-XDR order: a key only B writes is `added`,
/// one only A writes is `removed`, and one both write to different values
/// is `changed` (into a contract-data value by path, for an instance into
/// its storage map). A TTL that differs is reported on its own, in `ttl`.
/// Each is `breaking`, or `ignored` when its key (or, inside an instance,
/// every differing key) matches an `ignore_storage` pattern.
fn storage(
    a: &[DiffWrite],
    b: &[DiffWrite],
    rules: &Rules,
    describe_key: &dyn Fn(&[u8]) -> String,
    describe_entry: &dyn Fn(&[u8]) -> Result<Value, LaneError>,
) -> Result<Value, LaneError> {
    let by_key = |writes: &[DiffWrite]| -> BTreeMap<Vec<u8>, DiffWrite> {
        writes
            .iter()
            .map(|w| (w.key_xdr.clone(), w.clone()))
            .collect()
    };
    let (wa, wb) = (by_key(a), by_key(b));
    let view = |entry: &Option<Vec<u8>>| -> Result<Value, LaneError> {
        entry.as_deref().map_or(Ok(Value::Null), describe_entry)
    };
    let (mut added, mut removed, mut changed, mut ttl) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut keys: Vec<&Vec<u8>> = wa.keys().chain(wb.keys()).collect();
    keys.sort();
    keys.dedup();
    for key in keys {
        let key_class = if data_key(key).is_some_and(|k| rules.ignores_key(&k)) {
            "ignored"
        } else {
            "breaking"
        };
        let head = |class: &str| json!({ "key": describe_key(key), "key_xdr": super::base64(key), "class": class });
        match (wa.get(key), wb.get(key)) {
            (Some(x), None) => {
                let mut item = head(key_class);
                item["entry"] = view(&x.entry_xdr)?;
                removed.push(item);
            }
            (None, Some(y)) => {
                let mut item = head(key_class);
                item["entry"] = view(&y.entry_xdr)?;
                added.push(item);
            }
            (Some(x), Some(y)) => {
                if x.entry_xdr != y.entry_xdr {
                    let entries = match (&x.entry_xdr, &y.entry_xdr) {
                        (Some(ex), Some(ey)) => Some((
                            decode::<LedgerEntry>(ex, "LedgerEntry")?,
                            decode::<LedgerEntry>(ey, "LedgerEntry")?,
                        )),
                        _ => None,
                    };
                    let values = entries
                        .as_ref()
                        .and_then(|(ex, ey)| data_value(ex).zip(data_value(ey)));
                    let found = match values {
                        // An instance: the first difference in the keys not
                        // ignored is breaking; one only in ignored keys is
                        // still shown, as ignored.
                        Some((ScVal::ContractInstance(ix), ScVal::ContractInstance(iy))) => {
                            match first_difference(
                                &without_ignored(ix, rules),
                                &without_ignored(iy, rules),
                                "/value/storage",
                            )? {
                                Some(d) => Some((d, "breaking")),
                                None => first_difference(
                                    &ScVal::ContractInstance(ix.clone()),
                                    &ScVal::ContractInstance(iy.clone()),
                                    "/value",
                                )?
                                .map(|d| (d, "ignored")),
                            }
                        }
                        Some((vx, vy)) => {
                            first_difference(vx, vy, "/value")?.map(|d| (d, key_class))
                        }
                        // The entry itself differs elsewhere (its
                        // last-modified ledger, or it was deleted on one
                        // side).
                        None => None,
                    };
                    if let Some((d, class)) = found {
                        let mut item = head(class);
                        item["path"] = json!(d.path);
                        item["a"] = d.a;
                        item["b"] = d.b;
                        changed.push(item);
                    } else if entries.is_none() {
                        let mut item = head(key_class);
                        item["path"] = json!("");
                        item["a"] = view(&x.entry_xdr)?;
                        item["b"] = view(&y.entry_xdr)?;
                        changed.push(item);
                    }
                }
                if x.live_until != y.live_until {
                    let mut item = head(key_class);
                    item["a"] = json!(x.live_until);
                    item["b"] = json!(y.live_until);
                    ttl.push(item);
                }
            }
            (None, None) => unreachable!("every key came from one side"),
        }
    }
    Ok(json!({ "added": added, "removed": removed, "changed": changed, "ttl": ttl }))
}

fn signer(entry: &SorobanAuthorizationEntry) -> String {
    match &entry.credentials {
        SorobanCredentials::SourceAccount => "source account".to_string(),
        SorobanCredentials::Address(c) => c.address.to_string(),
        SorobanCredentials::AddressV2(c) => c.address.to_string(),
        SorobanCredentials::AddressWithDelegates(c) => c.address_credentials.address.to_string(),
    }
}

/// An authorized invocation tree: what is called with which arguments, and
/// what it calls in turn. Nonces and signatures are left out: they are not
/// what a signer agrees to.
fn invocation(inv: &SorobanAuthorizedInvocation) -> Result<Value, LaneError> {
    let mut out = match &inv.function {
        SorobanAuthorizedFunction::ContractFn(call) => json!({
            "contract_id": call.contract_address.to_string(),
            "function": call.function_name.0.to_utf8_string_lossy(),
            "args": call.args.iter().map(scval_json).collect::<Result<Vec<_>, _>>()?,
        }),
        SorobanAuthorizedFunction::CreateContractHostFn(_) => json!({ "kind": "create_contract" }),
        SorobanAuthorizedFunction::CreateContractV2HostFn(_) => {
            json!({ "kind": "create_contract_v2" })
        }
    };
    out["sub_invocations"] = Value::Array(
        inv.sub_invocations
            .iter()
            .map(invocation)
            .collect::<Result<_, _>>()?,
    );
    Ok(out)
}

/// Auth by signer: a signer only B needs is `added`, one only A needed is
/// `removed`, and a signer whose invocation tree differs (another function,
/// other arguments, another sub-invocation) is `changed`. Any of these is
/// `client_breaking`: a payload signed for A no longer matches B.
fn auth(a: &[Vec<u8>], b: &[Vec<u8>]) -> Result<Value, LaneError> {
    // Keyed by signer and its n-th entry, should one address sign twice.
    let trees = |entries: &[Vec<u8>]| -> Result<BTreeMap<(String, usize), Value>, LaneError> {
        let mut out = BTreeMap::new();
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        for raw in entries {
            let entry: SorobanAuthorizationEntry = decode(raw, "SorobanAuthorizationEntry")?;
            let who = signer(&entry);
            let n = seen.entry(who.clone()).or_default();
            out.insert((who, *n), invocation(&entry.root_invocation)?);
            *n += 1;
        }
        Ok(out)
    };
    let (ta, tb) = (trees(a)?, trees(b)?);
    let (mut added, mut removed, mut changed) = (Vec::new(), Vec::new(), Vec::new());
    let mut keys: Vec<&(String, usize)> = ta.keys().chain(tb.keys()).collect();
    keys.sort();
    keys.dedup();
    for key in keys {
        match (ta.get(key), tb.get(key)) {
            (Some(x), None) => {
                removed.push(json!({ "signer": key.0, "invocation": x, "class": "breaking" }))
            }
            (None, Some(y)) => {
                added.push(json!({ "signer": key.0, "invocation": y, "class": "breaking" }))
            }
            (Some(x), Some(y)) => {
                if let Some(d) = json_difference(x, y, "") {
                    changed.push(json!({ "signer": key.0, "path": d.path, "a": d.a, "b": d.b, "class": "breaking" }));
                }
            }
            (None, None) => unreachable!("every key came from one side"),
        }
    }
    let breaking = !(added.is_empty() && removed.is_empty() && changed.is_empty());
    Ok(json!({
        "client_breaking": breaking,
        "added": added,
        "removed": removed,
        "changed": changed,
    }))
}
