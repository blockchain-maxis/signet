//! The storage-layout check (#571): can the new build read what the old
//! one stored? The spec does not say which type each key holds, so a
//! stored value is matched to the old spec's types by its shape:
//!
//! - a map with symbol keys is the struct whose field names are exactly
//!   those keys;
//! - a vec led by a symbol is the union with a case of that name and arity.
//!
//! The same-named type in the new spec must then decode it. A build that
//! reads structs through CAP-86's sparse unpack takes a missing `Option`
//! field as `None` and ignores keys it does not declare, which is how
//! `Spec::decode` reads; a strict build needs the stored keys to be exactly
//! the new fields. Values of any other shape (a `u32`, an `Address`) match
//! no type and are not checked: that gap is stated, not hidden.

use serde_json::Value;

use super::soroban_env_host::xdr::{
    LedgerEntry, LedgerEntryData, ScSpecEntry, ScSpecTypeDef, ScSpecTypeUdt, ScSpecUdtUnionCaseV0,
    ScVal,
};
use super::spec::{generic, Spec};
use super::{decode, LaneError};

/// One stored value the new build cannot read.
pub struct Finding {
    pub key_xdr: Vec<u8>,
    /// Where in the entry: empty for a data entry's value, the instance
    /// storage key's JSON for a value inside an instance.
    pub inner_key: Option<Value>,
    pub decoded_key: Value,
    pub udt: String,
    pub reason: String,
}

fn symbol_text(v: &ScVal) -> Option<String> {
    match v {
        ScVal::Symbol(s) => Some(s.0.to_utf8_string_lossy()),
        _ => None,
    }
}

/// The old-spec type a stored value has the shape of, if any.
fn matched_udt(old: &Spec, value: &ScVal) -> Option<String> {
    match value {
        ScVal::Map(Some(map)) if !map.is_empty() => {
            let mut keys: Vec<String> = map
                .iter()
                .map(|e| symbol_text(&e.key))
                .collect::<Option<_>>()?;
            keys.sort();
            old.entries.iter().find_map(|e| match e {
                ScSpecEntry::UdtStructV0(s) => {
                    let mut fields: Vec<String> = s
                        .fields
                        .iter()
                        .map(|f| f.name.to_utf8_string_lossy())
                        .collect();
                    fields.sort();
                    (fields == keys).then(|| s.name.to_utf8_string_lossy())
                }
                _ => None,
            })
        }
        ScVal::Vec(Some(items)) => {
            let tag = symbol_text(items.first()?)?;
            let arity = items.len() - 1;
            old.entries.iter().find_map(|e| match e {
                ScSpecEntry::UdtUnionV0(u) => u
                    .cases
                    .iter()
                    .any(|c| match c {
                        ScSpecUdtUnionCaseV0::VoidV0(v) => {
                            v.name.to_utf8_string_lossy() == tag && arity == 0
                        }
                        ScSpecUdtUnionCaseV0::TupleV0(t) => {
                            t.name.to_utf8_string_lossy() == tag && t.type_.len() == arity
                        }
                    })
                    .then(|| u.name.to_utf8_string_lossy()),
                _ => None,
            })
        }
        _ => None,
    }
}

/// Why the new spec cannot read `value` as `udt`, if it cannot.
fn unreadable(new: &Spec, udt: &str, value: &ScVal, sparse: bool) -> Option<String> {
    let Some(entry) = definition(new, udt) else {
        return Some(format!("the new build's spec has no type {udt}"));
    };
    if let (ScSpecEntry::UdtStructV0(s), ScVal::Map(Some(map)), false) = (entry, value, sparse) {
        // A strict build unpacks exactly its declared fields.
        let mut stored: Vec<String> = map.iter().filter_map(|e| symbol_text(&e.key)).collect();
        let mut fields: Vec<String> = s
            .fields
            .iter()
            .map(|f| f.name.to_utf8_string_lossy())
            .collect();
        stored.sort();
        fields.sort();
        if stored != fields {
            let missing: Vec<_> = fields
                .iter()
                .filter(|f| !stored.contains(f))
                .cloned()
                .collect();
            let extra: Vec<_> = stored
                .iter()
                .filter(|f| !fields.contains(f))
                .cloned()
                .collect();
            return Some(format!(
                "the new build reads {udt} strictly (no CAP-86 sparse unpack), and the stored value's fields differ: missing {missing:?}, extra {extra:?}"
            ));
        }
    }
    let ty = ScSpecTypeDef::Udt(ScSpecTypeUdt {
        name: udt.try_into().ok()?,
    });
    new.decode(&ty, value, "", 0).err().map(|e| match e {
        LaneError::Decode(why) | LaneError::Argument { expected: why, .. } => {
            format!("the new {udt} does not decode the stored value: {why}")
        }
        other => format!("the new {udt} does not decode the stored value: {other}"),
    })
}

/// Static findings for `entries` (`(LedgerKey, LedgerEntry)` XDR): each
/// contract-data value, and each value in an instance's storage, matched to
/// an old type the new spec cannot read.
pub fn static_findings(
    old: &Spec,
    new: &Spec,
    sparse: bool,
    entries: &[(Vec<u8>, Vec<u8>)],
) -> Result<Vec<Finding>, LaneError> {
    let mut out = Vec::new();
    for (key_xdr, entry_xdr) in entries {
        let entry: LedgerEntry = decode(entry_xdr, "LedgerEntry")?;
        let LedgerEntryData::ContractData(data) = &entry.data else {
            continue;
        };
        let mut check = |inner: Option<&ScVal>, value: &ScVal| -> Result<(), LaneError> {
            let Some(udt) = matched_udt(old, value) else {
                return Ok(());
            };
            if let Some(reason) = unreadable(new, &udt, value, sparse) {
                out.push(Finding {
                    key_xdr: key_xdr.clone(),
                    inner_key: inner.map(generic).transpose()?,
                    decoded_key: generic(inner.unwrap_or(&data.key))?,
                    udt,
                    reason,
                });
            }
            Ok(())
        };
        match &data.val {
            ScVal::ContractInstance(instance) => {
                for item in instance.storage.iter().flat_map(|m| m.iter()) {
                    check(Some(&item.key), &item.val)?;
                }
            }
            value => check(None, value)?,
        }
    }
    Ok(out)
}

/// The keys of `entries` whose values match an old type at all: what a
/// failed replay that read them can be attributed to.
pub fn typed_keys(
    old: &Spec,
    entries: &[(Vec<u8>, Vec<u8>)],
) -> Result<Vec<(Vec<u8>, Value, String)>, LaneError> {
    let mut out = Vec::new();
    for (key_xdr, entry_xdr) in entries {
        let entry: LedgerEntry = decode(entry_xdr, "LedgerEntry")?;
        let LedgerEntryData::ContractData(data) = &entry.data else {
            continue;
        };
        let values: Vec<(&ScVal, &ScVal)> = match &data.val {
            ScVal::ContractInstance(i) => i
                .storage
                .iter()
                .flat_map(|m| m.iter())
                .map(|e| (&e.key, &e.val))
                .collect(),
            v => vec![(&data.key, v)],
        };
        for (k, v) in values {
            if let Some(udt) = matched_udt(old, v) {
                out.push((key_xdr.clone(), generic(k)?, udt));
            }
        }
    }
    Ok(out)
}

/// A type's definition in a spec, for telling whether it changed.
pub fn definition<'a>(spec: &'a Spec, udt: &str) -> Option<&'a ScSpecEntry> {
    spec.entries.iter().find(|e| match e {
        ScSpecEntry::UdtStructV0(s) => s.name.to_utf8_string_lossy() == udt,
        ScSpecEntry::UdtUnionV0(u) => u.name.to_utf8_string_lossy() == udt,
        ScSpecEntry::UdtEnumV0(x) => x.name.to_utf8_string_lossy() == udt,
        _ => false,
    })
}

/// How many stored values match no type: plain values (a `u32`, an
/// `Address`) the static check cannot say anything about.
pub fn unmatched_values(old: &Spec, entries: &[(Vec<u8>, Vec<u8>)]) -> Result<usize, LaneError> {
    let mut n = 0;
    for (_, entry_xdr) in entries {
        let entry: LedgerEntry = decode(entry_xdr, "LedgerEntry")?;
        let LedgerEntryData::ContractData(data) = &entry.data else {
            continue;
        };
        match &data.val {
            ScVal::ContractInstance(i) => {
                n += i
                    .storage
                    .iter()
                    .flat_map(|m| m.iter())
                    .filter(|e| matched_udt(old, &e.val).is_none())
                    .count();
            }
            v => n += usize::from(matched_udt(old, v).is_none()),
        }
    }
    Ok(n)
}
