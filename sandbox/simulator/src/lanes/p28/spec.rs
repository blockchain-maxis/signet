//! The contract spec for the p28 lane (#545, #546): the `SpecJson` v1
//! document, JSON arguments to `ScVal`, and `ScVal` back to JSON.
//!
//! The JSON shape is the shared reader's (`@signet/spec`'s
//! `functionArgsSchema`, which follows `@stellar/stellar-sdk`'s
//! `contract.Spec#jsonSchema`), so the terminal, the local UI and saved calls
//! all speak one encoding. Where that shape differs from what
//! `soroban-spec-tools` (the crate `stellar contract invoke` uses) accepts,
//! this module follows the shared reader; each such choice is noted at the
//! arm that makes it:
//!
//! | Type                                   | JSON                                   |
//! | -------------------------------------- | -------------------------------------- |
//! | `u32`, `i32`                           | number                                 |
//! | `u64` … `i256`, `timepoint`, `duration`| decimal string (a number is accepted)  |
//! | `bool` / `void`                        | boolean / null                         |
//! | `bytes`, `BytesN<N>`                   | base64 string                          |
//! | `string`, `symbol`                     | string                                 |
//! | `address`, `muxedAddress`              | strkey string (`G…`, `C…`, `M…`)       |
//! | `Vec<T>`, tuple, tuple struct          | array                                  |
//! | `Map<K, V>`                            | array of `[key, value]` pairs          |
//! | `Option<T>`                            | `T`, or null / absent                  |
//! | struct                                 | object keyed by field name             |
//! | union                                  | `{"tag": case, "values": [...]}`       |
//! | enum, error enum                       | number (the variant's value)           |

use std::str::FromStr;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use soroban_env_host::xdr::{
    BytesM, ContractEvent, ContractEventBody, Duration, Int128Parts, Int256Parts, Limited, Limits,
    ReadXdr, ScAddress, ScBytes, ScEnvMetaEntry, ScError, ScMap, ScMapEntry, ScMetaEntry,
    ScSpecEntry, ScSpecEventDataFormat, ScSpecEventParamLocationV0, ScSpecFunctionV0,
    ScSpecTypeDef, ScSpecTypeUdt, ScSpecUdtUnionCaseV0, ScString, ScSymbol, ScVal, ScVec, StringM,
    TimePoint, UInt128Parts, UInt256Parts, VecM,
};

use super::{custom_sections, encode, hex, LaneError, SPEC_SECTION};

/// The same bounds `@signet/spec`'s `parseContractSpec` applies.
pub const MAX_WASM_BYTES: usize = 256 * 1024;
pub const MAX_SPEC_ENTRIES: usize = 1_024;
pub const MAX_TYPE_DEPTH: usize = 32;
const MAX_META_ENTRIES: usize = 1_024;

const META_SECTION: &str = "contractmetav0";
const ENV_META_SECTION: &str = "contractenvmetav0";

/// Records which decoder produced a `SpecJson`, in the field the TS reader
/// fills with its `@stellar/stellar-sdk` version.
pub const DECODER_VERSION: &str = "signet-simulator/stellar-xdr@28.0.0";

/// A parsed contract spec.
pub struct Spec {
    pub entries: Vec<ScSpecEntry>,
}

impl Spec {
    /// Read `contractspecv0` from an executable. A module with no spec
    /// section has an empty spec.
    pub fn from_wasm(wasm: &[u8]) -> Result<Self, LaneError> {
        if wasm.len() > MAX_WASM_BYTES {
            return Err(LaneError::InvalidWasm(format!(
                "module size {} exceeds maximum of {MAX_WASM_BYTES} bytes",
                wasm.len()
            )));
        }
        let mut entries = Vec::new();
        for payload in custom_sections(wasm, SPEC_SECTION)?.into_iter().take(1) {
            let mut reader = Limited::new(std::io::Cursor::new(payload), Limits::none());
            for entry in ScSpecEntry::read_xdr_iter(&mut reader) {
                if entries.len() >= MAX_SPEC_ENTRIES {
                    return Err(LaneError::InvalidWasm(format!(
                        "{SPEC_SECTION} exceeds maximum of {MAX_SPEC_ENTRIES} entries"
                    )));
                }
                entries.push(
                    entry.map_err(|e| LaneError::InvalidWasm(format!("{SPEC_SECTION}: {e}")))?,
                );
            }
        }
        Ok(Self { entries })
    }

    pub fn function(&self, name: &str) -> Option<&ScSpecFunctionV0> {
        self.entries.iter().find_map(|e| match e {
            ScSpecEntry::FunctionV0(f) if f.name.to_utf8_string_lossy() == name => Some(f),
            _ => None,
        })
    }

    fn udt(&self, name: &str) -> Option<&ScSpecEntry> {
        self.entries.iter().find(|e| match e {
            ScSpecEntry::UdtStructV0(s) => s.name.to_utf8_string_lossy() == name,
            ScSpecEntry::UdtUnionV0(u) => u.name.to_utf8_string_lossy() == name,
            ScSpecEntry::UdtEnumV0(en) => en.name.to_utf8_string_lossy() == name,
            ScSpecEntry::UdtErrorEnumV0(en) => en.name.to_utf8_string_lossy() == name,
            _ => false,
        })
    }

    /// Every error-enum case whose value is `code`, as `(enum, name, doc)`.
    /// More than one when the contract declares several error enums.
    pub fn error_cases(&self, code: u32) -> Vec<(String, String, String)> {
        let mut out = Vec::new();
        for entry in &self.entries {
            if let ScSpecEntry::UdtErrorEnumV0(en) = entry {
                for case in en.cases.iter() {
                    if case.value == code {
                        out.push((
                            en.name.to_utf8_string_lossy(),
                            case.name.to_utf8_string_lossy(),
                            case.doc.to_utf8_string_lossy(),
                        ));
                    }
                }
            }
        }
        out
    }
}

// ─── SpecJson v1 ───────────────────────────────────────────────────────────────

/// The `SpecJson` v1 document (packages/spec/schema/spec-json.v1.schema.json)
/// for an executable, built the way `@signet/spec`'s `parseContractSpec` +
/// `toSpecJson` build it.
pub fn spec_json(wasm: &[u8]) -> Result<Value, LaneError> {
    let spec = Spec::from_wasm(wasm)?;
    let mut entries_xdr = Vec::with_capacity(spec.entries.len());
    for entry in &spec.entries {
        entries_xdr.push(super::base64(&encode(entry, "ScSpecEntry")?));
    }

    let mut functions = Vec::new();
    let mut types = Vec::new();
    let mut errors = Vec::new();
    for entry in &spec.entries {
        match entry {
            ScSpecEntry::FunctionV0(f) => {
                let name = f.name.to_utf8_string_lossy();
                functions.push(json!({
                    "name": name,
                    "doc": f.doc.to_utf8_string_lossy(),
                    "isConstructor": name == "__constructor",
                    "inputs": f.inputs.iter().map(|i| json!({
                        "name": i.name.to_utf8_string_lossy(),
                        "doc": i.doc.to_utf8_string_lossy(),
                        "type": type_ref(&i.type_, 0),
                    })).collect::<Vec<_>>(),
                    "outputs": f.outputs.iter().map(|o| type_ref(o, 0)).collect::<Vec<_>>(),
                }));
            }
            ScSpecEntry::UdtStructV0(s) => types.push(json!({
                "kind": "struct",
                "name": s.name.to_utf8_string_lossy(),
                "doc": s.doc.to_utf8_string_lossy(),
                "fields": s.fields.iter().map(|f| json!({
                    "name": f.name.to_utf8_string_lossy(),
                    "doc": f.doc.to_utf8_string_lossy(),
                    "type": type_ref(&f.type_, 0),
                })).collect::<Vec<_>>(),
            })),
            ScSpecEntry::UdtUnionV0(u) => types.push(json!({
                "kind": "union",
                "name": u.name.to_utf8_string_lossy(),
                "doc": u.doc.to_utf8_string_lossy(),
                "cases": u.cases.iter().map(|c| match c {
                    ScSpecUdtUnionCaseV0::VoidV0(v) => json!({
                        "name": v.name.to_utf8_string_lossy(),
                        "doc": v.doc.to_utf8_string_lossy(),
                        "fields": [],
                    }),
                    // Tuple payloads are positional, so fields are named by
                    // index and carry no doc (as the TS reader does).
                    ScSpecUdtUnionCaseV0::TupleV0(t) => json!({
                        "name": t.name.to_utf8_string_lossy(),
                        "doc": t.doc.to_utf8_string_lossy(),
                        "fields": t.type_.iter().enumerate().map(|(i, ty)| json!({
                            "name": i.to_string(),
                            "type": type_ref(ty, 0),
                        })).collect::<Vec<_>>(),
                    }),
                }).collect::<Vec<_>>(),
            })),
            ScSpecEntry::UdtEnumV0(e) => types.push(json!({
                "kind": "enum",
                "name": e.name.to_utf8_string_lossy(),
                "doc": e.doc.to_utf8_string_lossy(),
                "variants": e.cases.iter().map(|c| json!({
                    "name": c.name.to_utf8_string_lossy(),
                    "doc": c.doc.to_utf8_string_lossy(),
                    "value": c.value,
                })).collect::<Vec<_>>(),
            })),
            ScSpecEntry::UdtErrorEnumV0(e) => {
                let enum_name = e.name.to_utf8_string_lossy();
                for c in e.cases.iter() {
                    errors.push(json!({
                        "enumName": enum_name,
                        "name": c.name.to_utf8_string_lossy(),
                        "value": c.value,
                        "doc": c.doc.to_utf8_string_lossy(),
                    }));
                }
            }
            _ => {}
        }
    }

    let mut doc = json!({
        "schemaVersion": 1,
        "wasmHash": hex(&Sha256::digest(wasm)),
        "sdkVersion": DECODER_VERSION,
        "entriesXdr": entries_xdr,
        "functions": functions,
        "types": types,
        "errors": errors,
        // The TS reader leaves events to a separate pass (events.ts), so
        // parsing alone yields none; match it.
        "events": [],
        "warnings": [],
        "provenance": "embedded",
    });
    let mut warnings = Vec::new();
    if let Some(section) = custom_sections(wasm, META_SECTION)?.first() {
        match build_meta(section) {
            Ok(build) => doc["build"] = build,
            Err(e) => warnings.push(format!("{META_SECTION} could not be decoded: {e}")),
        }
    }
    if let Some(section) = custom_sections(wasm, ENV_META_SECTION)?.first() {
        match env_meta(section) {
            Ok(Some(env)) => doc["env"] = env,
            Ok(None) => warnings.push(format!("{ENV_META_SECTION} has no interface version")),
            Err(e) => warnings.push(format!("{ENV_META_SECTION} could not be decoded: {e}")),
        }
    }
    doc["warnings"] = json!(warnings);
    Ok(doc)
}

fn build_meta(section: &[u8]) -> Result<Value, String> {
    let mut reader = Limited::new(std::io::Cursor::new(section), Limits::none());
    let mut pairs = Map::new();
    for (n, entry) in ScMetaEntry::read_xdr_iter(&mut reader).enumerate() {
        if n >= MAX_META_ENTRIES {
            return Err(format!(
                "meta section exceeds maximum of {MAX_META_ENTRIES} entries"
            ));
        }
        let ScMetaEntry::ScMetaV0(meta) = entry.map_err(|e| e.to_string())?;
        let key = String::from_utf8(meta.key.to_vec()).map_err(|e| e.to_string())?;
        let val = String::from_utf8(meta.val.to_vec()).map_err(|e| e.to_string())?;
        pairs.insert(key, Value::String(val));
    }
    let mut build = Map::new();
    if let Some(v) = pairs.get("rsver") {
        build.insert("rustVersion".into(), v.clone());
    }
    if let Some(v) = pairs.get("rssdkver") {
        build.insert("sdkVersion".into(), v.clone());
    }
    build.insert("entries".into(), Value::Object(pairs));
    Ok(Value::Object(build))
}

fn env_meta(section: &[u8]) -> Result<Option<Value>, String> {
    let mut reader = Limited::new(std::io::Cursor::new(section), Limits::none());
    if let Some(entry) = ScEnvMetaEntry::read_xdr_iter(&mut reader).next() {
        let ScEnvMetaEntry::ScEnvMetaKindInterfaceVersion(v) = entry.map_err(|e| e.to_string())?;
        return Ok(Some(
            json!({ "protocolVersion": v.protocol, "preRelease": v.pre_release }),
        ));
    }
    Ok(None)
}

/// `@signet/spec`'s `TypeRef` for a spec type.
pub fn type_ref(def: &ScSpecTypeDef, depth: usize) -> Value {
    let arm = def.name();
    if depth >= MAX_TYPE_DEPTH {
        return json!({ "type": "unknown", "xdrArm": ts_arm(arm) });
    }
    let primitive = |s: &str| Value::String(s.into());
    match def {
        ScSpecTypeDef::Val => primitive("val"),
        ScSpecTypeDef::Bool => primitive("bool"),
        ScSpecTypeDef::Void => primitive("void"),
        ScSpecTypeDef::Error => primitive("error"),
        ScSpecTypeDef::U32 => primitive("u32"),
        ScSpecTypeDef::I32 => primitive("i32"),
        ScSpecTypeDef::U64 => primitive("u64"),
        ScSpecTypeDef::I64 => primitive("i64"),
        ScSpecTypeDef::Timepoint => primitive("timepoint"),
        ScSpecTypeDef::Duration => primitive("duration"),
        ScSpecTypeDef::U128 => primitive("u128"),
        ScSpecTypeDef::I128 => primitive("i128"),
        ScSpecTypeDef::U256 => primitive("u256"),
        ScSpecTypeDef::I256 => primitive("i256"),
        ScSpecTypeDef::Bytes => primitive("bytes"),
        ScSpecTypeDef::String => primitive("string"),
        ScSpecTypeDef::Symbol => primitive("symbol"),
        ScSpecTypeDef::Address => primitive("address"),
        ScSpecTypeDef::MuxedAddress => primitive("muxedAddress"),
        ScSpecTypeDef::BytesN(b) => json!({ "type": "bytes_n", "n": b.n }),
        ScSpecTypeDef::Option(o) => {
            json!({ "type": "option", "value": type_ref(&o.value_type, depth + 1) })
        }
        ScSpecTypeDef::Result(r) => json!({
            "type": "result",
            "ok": type_ref(&r.ok_type, depth + 1),
            "error": type_ref(&r.error_type, depth + 1),
        }),
        ScSpecTypeDef::Vec(v) => {
            json!({ "type": "vec", "element": type_ref(&v.element_type, depth + 1) })
        }
        ScSpecTypeDef::Map(m) => json!({
            "type": "map",
            "key": type_ref(&m.key_type, depth + 1),
            "value": type_ref(&m.value_type, depth + 1),
        }),
        ScSpecTypeDef::Tuple(t) => json!({
            "type": "tuple",
            "elements": t.value_types.iter().map(|e| type_ref(e, depth + 1)).collect::<Vec<_>>(),
        }),
        ScSpecTypeDef::Udt(u) => json!({ "type": "named", "name": u.name.to_utf8_string_lossy() }),
    }
}

/// The JS SDK's arm name (`scSpecTypeFoo`) for an XDR arm name (`Foo`).
fn ts_arm(arm: &str) -> String {
    format!("scSpecType{arm}")
}

/// A short name for a spec type, for error messages.
pub fn type_name(def: &ScSpecTypeDef) -> String {
    match def {
        ScSpecTypeDef::BytesN(b) => format!("BytesN<{}>", b.n),
        ScSpecTypeDef::Option(o) => format!("Option<{}>", type_name(&o.value_type)),
        ScSpecTypeDef::Result(r) => format!(
            "Result<{}, {}>",
            type_name(&r.ok_type),
            type_name(&r.error_type)
        ),
        ScSpecTypeDef::Vec(v) => format!("Vec<{}>", type_name(&v.element_type)),
        ScSpecTypeDef::Map(m) => format!(
            "Map<{}, {}>",
            type_name(&m.key_type),
            type_name(&m.value_type)
        ),
        ScSpecTypeDef::Tuple(t) => format!(
            "({})",
            t.value_types
                .iter()
                .map(type_name)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        ScSpecTypeDef::Udt(u) => u.name.to_utf8_string_lossy(),
        ScSpecTypeDef::Val => "Val".into(),
        ScSpecTypeDef::Bool => "bool".into(),
        ScSpecTypeDef::Void => "void".into(),
        ScSpecTypeDef::Error => "Error".into(),
        ScSpecTypeDef::U32 => "u32".into(),
        ScSpecTypeDef::I32 => "i32".into(),
        ScSpecTypeDef::U64 => "u64".into(),
        ScSpecTypeDef::I64 => "i64".into(),
        ScSpecTypeDef::Timepoint => "timepoint".into(),
        ScSpecTypeDef::Duration => "duration".into(),
        ScSpecTypeDef::U128 => "u128".into(),
        ScSpecTypeDef::I128 => "i128".into(),
        ScSpecTypeDef::U256 => "u256".into(),
        ScSpecTypeDef::I256 => "i256".into(),
        ScSpecTypeDef::Bytes => "Bytes".into(),
        ScSpecTypeDef::String => "String".into(),
        ScSpecTypeDef::Symbol => "Symbol".into(),
        ScSpecTypeDef::Address => "Address (G… or C…)".into(),
        ScSpecTypeDef::MuxedAddress => "MuxedAddress (G…, M… or C…)".into(),
    }
}

// ─── JSON → ScVal ──────────────────────────────────────────────────────────────

fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn arg_error(path: &str, expected: impl Into<String>, got: impl Into<String>) -> LaneError {
    LaneError::Argument {
        path: path.to_string(),
        expected: expected.into(),
        got: got.into(),
    }
}

fn mismatch(path: &str, expected: impl Into<String>, v: &Value) -> LaneError {
    arg_error(path, expected, json_kind(v))
}

fn child(path: &str, field: &str) -> String {
    if path.is_empty() {
        field.to_string()
    } else {
        format!("{path}.{field}")
    }
}

fn index(path: &str, i: usize) -> String {
    format!("{path}[{i}]")
}

fn xdr_err<'a>(
    path: &'a str,
    what: &'a str,
) -> impl Fn(soroban_env_host::xdr::Error) -> LaneError + 'a {
    move |e| {
        arg_error(
            path,
            what.to_string(),
            format!("a value it cannot hold ({e})"),
        )
    }
}

impl Spec {
    /// Encode a function's arguments. `args` is an object keyed by argument
    /// name (the shared reader's shape) or an array in declaration order. An
    /// `Option` argument may be left out.
    pub fn encode_args(&self, function: &str, args: &Value) -> Result<Vec<ScVal>, LaneError> {
        let f = self
            .function(function)
            .ok_or_else(|| LaneError::InvalidInput {
                what: "function",
                detail: format!("the contract has no function `{function}`"),
            })?;
        let inputs: Vec<(String, &ScSpecTypeDef)> = f
            .inputs
            .iter()
            .map(|i| (i.name.to_utf8_string_lossy(), &i.type_))
            .collect();
        let null = Value::Null;
        match args {
            Value::Object(map) => {
                if let Some(extra) = map.keys().find(|k| !inputs.iter().any(|(n, _)| n == *k)) {
                    return Err(arg_error(
                        extra,
                        format!("one of `{function}`'s arguments ({})", names(&inputs)),
                        "an unknown argument",
                    ));
                }
                inputs
                    .iter()
                    .map(|(name, ty)| match map.get(name) {
                        Some(v) => self.encode(ty, v, name, 0),
                        None if matches!(ty, ScSpecTypeDef::Option(_)) => {
                            self.encode(ty, &null, name, 0)
                        }
                        None => Err(arg_error(
                            name,
                            type_name(ty),
                            "nothing (the argument is missing)",
                        )),
                    })
                    .collect()
            }
            Value::Array(items) => {
                if items.len() > inputs.len() {
                    return Err(arg_error(
                        "args",
                        format!("at most {} arguments ({})", inputs.len(), names(&inputs)),
                        format!("{}", items.len()),
                    ));
                }
                inputs
                    .iter()
                    .enumerate()
                    .map(|(i, (name, ty))| match items.get(i) {
                        Some(v) => self.encode(ty, v, name, 0),
                        None if matches!(ty, ScSpecTypeDef::Option(_)) => {
                            self.encode(ty, &null, name, 0)
                        }
                        None => Err(arg_error(
                            name,
                            type_name(ty),
                            "nothing (the argument is missing)",
                        )),
                    })
                    .collect()
            }
            other => Err(mismatch(
                "args",
                "an object of named arguments or an array",
                other,
            )),
        }
    }

    /// Encode one JSON value as `ty`.
    pub fn encode(
        &self,
        ty: &ScSpecTypeDef,
        v: &Value,
        path: &str,
        depth: usize,
    ) -> Result<ScVal, LaneError> {
        if depth > MAX_TYPE_DEPTH {
            return Err(arg_error(
                path,
                "a value nested at most 32 deep",
                "a deeper value",
            ));
        }
        Ok(match ty {
            ScSpecTypeDef::Bool => match v {
                Value::Bool(b) => ScVal::Bool(*b),
                _ => return Err(mismatch(path, "bool", v)),
            },
            ScSpecTypeDef::Void => match v {
                Value::Null => ScVal::Void,
                _ => return Err(mismatch(path, "void (null)", v)),
            },
            ScSpecTypeDef::U32 => ScVal::U32(small_int(v, path, "u32")?),
            ScSpecTypeDef::I32 => ScVal::I32(small_int(v, path, "i32")?),
            // 64-bit and wider integers are decimal strings in the shared
            // schema (JS numbers lose precision past 2^53); a JSON integer is
            // accepted too, when serde_json holds it exactly.
            ScSpecTypeDef::U64 => ScVal::U64(big_int::<u64>(v, path, "u64")?),
            ScSpecTypeDef::I64 => ScVal::I64(big_int::<i64>(v, path, "i64")?),
            ScSpecTypeDef::Timepoint => {
                ScVal::Timepoint(TimePoint(big_int::<u64>(v, path, "timepoint")?))
            }
            ScSpecTypeDef::Duration => {
                ScVal::Duration(Duration(big_int::<u64>(v, path, "duration")?))
            }
            ScSpecTypeDef::U128 => {
                let n = big_int::<u128>(v, path, "u128")?;
                ScVal::U128(UInt128Parts {
                    hi: (n >> 64) as u64,
                    lo: n as u64,
                })
            }
            ScSpecTypeDef::I128 => {
                let n = big_int::<i128>(v, path, "i128")?;
                ScVal::I128(Int128Parts {
                    hi: (n >> 64) as i64,
                    lo: n as u64,
                })
            }
            ScSpecTypeDef::U256 => {
                let [hi_hi, hi_lo, lo_hi, lo_lo] = u256(v, path)?;
                ScVal::U256(UInt256Parts {
                    hi_hi,
                    hi_lo,
                    lo_hi,
                    lo_lo,
                })
            }
            ScSpecTypeDef::I256 => {
                let [hi_hi, hi_lo, lo_hi, lo_lo] = i256(v, path)?;
                ScVal::I256(Int256Parts {
                    hi_hi: hi_hi as i64,
                    hi_lo,
                    lo_hi,
                    lo_lo,
                })
            }
            // Bytes are base64 in the shared schema (soroban-spec-tools reads
            // hex); a hex string would silently decode as different bytes, so
            // only base64 is accepted.
            ScSpecTypeDef::Bytes => {
                let bytes = base64_bytes(v, path, "bytes (base64)")?;
                ScVal::Bytes(ScBytes(
                    BytesM::try_from(bytes).map_err(xdr_err(path, "bytes"))?,
                ))
            }
            ScSpecTypeDef::BytesN(b) => {
                let expected = format!("BytesN<{}> (base64 of exactly {} bytes)", b.n, b.n);
                let bytes = base64_bytes(v, path, &expected)?;
                if bytes.len() != b.n as usize {
                    return Err(arg_error(path, expected, format!("{} bytes", bytes.len())));
                }
                ScVal::Bytes(ScBytes(
                    BytesM::try_from(bytes).map_err(xdr_err(path, "bytes"))?,
                ))
            }
            ScSpecTypeDef::String => match v {
                Value::String(s) => ScVal::String(ScString(
                    StringM::try_from(s.as_bytes().to_vec()).map_err(xdr_err(path, "String"))?,
                )),
                _ => return Err(mismatch(path, "String", v)),
            },
            ScSpecTypeDef::Symbol => match v {
                Value::String(s) => ScVal::Symbol(symbol(s, path)?),
                _ => return Err(mismatch(path, "Symbol", v)),
            },
            ScSpecTypeDef::Address => match v {
                Value::String(s) => match ScAddress::from_str(s) {
                    Ok(a @ (ScAddress::Account(_) | ScAddress::Contract(_))) => ScVal::Address(a),
                    _ => return Err(arg_error(path, "Address (G… or C…)", format!("{s:?}"))),
                },
                _ => return Err(mismatch(path, "Address (G… or C…)", v)),
            },
            ScSpecTypeDef::MuxedAddress => match v {
                Value::String(s) => match ScAddress::from_str(s) {
                    Ok(
                        a @ (ScAddress::Account(_)
                        | ScAddress::MuxedAccount(_)
                        | ScAddress::Contract(_)),
                    ) => ScVal::Address(a),
                    _ => {
                        return Err(arg_error(
                            path,
                            "MuxedAddress (G…, M… or C…)",
                            format!("{s:?}"),
                        ))
                    }
                },
                _ => return Err(mismatch(path, "MuxedAddress (G…, M… or C…)", v)),
            },
            ScSpecTypeDef::Option(o) => match v {
                Value::Null => ScVal::Void,
                _ => self.encode(&o.value_type, v, path, depth + 1)?,
            },
            // A Result in argument position is its Ok value (the SDK's
            // jsonSchema types it as the ok type).
            ScSpecTypeDef::Result(r) => self.encode(&r.ok_type, v, path, depth + 1)?,
            ScSpecTypeDef::Vec(t) => match v {
                Value::Array(items) => vec_of(
                    items
                        .iter()
                        .enumerate()
                        .map(|(i, x)| self.encode(&t.element_type, x, &index(path, i), depth + 1))
                        .collect::<Result<Vec<_>, _>>()?,
                    path,
                )?,
                _ => {
                    return Err(mismatch(
                        path,
                        format!("Vec<{}> (array)", type_name(&t.element_type)),
                        v,
                    ))
                }
            },
            ScSpecTypeDef::Tuple(t) => match v {
                Value::Array(items) if items.len() == t.value_types.len() => vec_of(
                    t.value_types
                        .iter()
                        .zip(items)
                        .enumerate()
                        .map(|(i, (ty, x))| self.encode(ty, x, &index(path, i), depth + 1))
                        .collect::<Result<Vec<_>, _>>()?,
                    path,
                )?,
                Value::Array(items) => {
                    return Err(arg_error(
                        path,
                        format!("{} (array of {})", type_name(ty), t.value_types.len()),
                        format!("array of {}", items.len()),
                    ))
                }
                _ => return Err(mismatch(path, format!("{} (array)", type_name(ty)), v)),
            },
            // Maps are arrays of [key, value] pairs in the shared schema. An
            // object is accepted too when the keys are strings or symbols,
            // since that is how a person writes such a map by hand.
            ScSpecTypeDef::Map(m) => {
                let pairs: Vec<(Value, &Value)> = match v {
                    Value::Array(items) => items
                        .iter()
                        .enumerate()
                        .map(|(i, pair)| match pair {
                            Value::Array(kv) if kv.len() == 2 => Ok((kv[0].clone(), &kv[1])),
                            _ => Err(mismatch(&index(path, i), "a [key, value] pair", pair)),
                        })
                        .collect::<Result<_, _>>()?,
                    Value::Object(obj)
                        if matches!(*m.key_type, ScSpecTypeDef::String | ScSpecTypeDef::Symbol) =>
                    {
                        obj.iter()
                            .map(|(k, x)| (Value::String(k.clone()), x))
                            .collect()
                    }
                    _ => {
                        return Err(mismatch(
                            path,
                            format!("{} (array of [key, value] pairs)", type_name(ty)),
                            v,
                        ))
                    }
                };
                let mut entries = Vec::with_capacity(pairs.len());
                for (i, (k, x)) in pairs.iter().enumerate() {
                    let at = index(path, i);
                    entries.push(ScMapEntry {
                        key: self.encode(&m.key_type, k, &format!("{at}[0]"), depth + 1)?,
                        val: self.encode(&m.value_type, x, &format!("{at}[1]"), depth + 1)?,
                    });
                }
                ScVal::Map(Some(ScMap::sorted_from(entries).map_err(|_| {
                    arg_error(
                        path,
                        format!("{} with distinct keys", type_name(ty)),
                        "a duplicate key",
                    )
                })?))
            }
            ScSpecTypeDef::Udt(u) => {
                self.encode_udt(&u.name.to_utf8_string_lossy(), v, path, depth)?
            }
            ScSpecTypeDef::Error => match v {
                Value::Number(_) => ScVal::Error(ScError::Contract(small_int(
                    v,
                    path,
                    "Error (contract error code)",
                )?)),
                _ => return Err(mismatch(path, "Error (contract error code)", v)),
            },
            ScSpecTypeDef::Val => {
                return Err(arg_error(
                    path,
                    "a value of a declared type (Val has no JSON form)",
                    json_kind(v),
                ))
            }
        })
    }

    fn encode_udt(
        &self,
        name: &str,
        v: &Value,
        path: &str,
        depth: usize,
    ) -> Result<ScVal, LaneError> {
        let Some(entry) = self.udt(name) else {
            return Err(LaneError::InvalidWasm(format!(
                "the spec names type `{name}` but does not define it"
            )));
        };
        Ok(match entry {
            ScSpecEntry::UdtStructV0(s) => {
                let tuple_struct = !s.fields.is_empty()
                    && s.fields
                        .iter()
                        .all(|f| f.name.to_utf8_string_lossy().parse::<u32>().is_ok());
                if tuple_struct {
                    // A tuple struct is a vector on-chain; accept an array, or
                    // an object keyed "0", "1", ... as the SDK does.
                    let items: Vec<&Value> = match v {
                        Value::Array(items) if items.len() == s.fields.len() => {
                            items.iter().collect()
                        }
                        Value::Object(obj) => (0..s.fields.len())
                            .map(|i| {
                                obj.get(&i.to_string()).ok_or_else(|| {
                                    arg_error(
                                        &index(path, i),
                                        type_name(&s.fields[i].type_),
                                        "nothing",
                                    )
                                })
                            })
                            .collect::<Result<_, _>>()?,
                        _ => {
                            return Err(mismatch(
                                path,
                                format!("{name} (array of {})", s.fields.len()),
                                v,
                            ))
                        }
                    };
                    vec_of(
                        s.fields
                            .iter()
                            .zip(items)
                            .enumerate()
                            .map(|(i, (f, x))| self.encode(&f.type_, x, &index(path, i), depth + 1))
                            .collect::<Result<Vec<_>, _>>()?,
                        path,
                    )?
                } else {
                    let Value::Object(obj) = v else {
                        return Err(mismatch(path, format!("{name} (object)"), v));
                    };
                    if let Some(extra) = obj.keys().find(|k| {
                        !s.fields
                            .iter()
                            .any(|f| f.name.to_utf8_string_lossy() == **k)
                    }) {
                        return Err(arg_error(
                            &child(path, extra),
                            format!("a field of {name}"),
                            "an unknown field",
                        ));
                    }
                    let null = Value::Null;
                    let mut entries = Vec::with_capacity(s.fields.len());
                    for f in s.fields.iter() {
                        let field = f.name.to_utf8_string_lossy();
                        let at = child(path, &field);
                        let x = match obj.get(&field) {
                            Some(x) => x,
                            None if matches!(f.type_, ScSpecTypeDef::Option(_)) => &null,
                            None => {
                                return Err(arg_error(
                                    &at,
                                    type_name(&f.type_),
                                    "nothing (the field is missing)",
                                ))
                            }
                        };
                        entries.push(ScMapEntry {
                            key: ScVal::Symbol(symbol(&field, &at)?),
                            val: self.encode(&f.type_, x, &at, depth + 1)?,
                        });
                    }
                    ScVal::Map(Some(ScMap::sorted_from(entries).map_err(|_| {
                        arg_error(path, name.to_string(), "fields that do not form a map")
                    })?))
                }
            }
            ScSpecEntry::UdtUnionV0(u) => {
                let Value::Object(obj) = v else {
                    return Err(mismatch(
                        path,
                        format!("{name} ({{\"tag\": …, \"values\": […]}})"),
                        v,
                    ));
                };
                let Some(Value::String(tag)) = obj.get("tag") else {
                    return Err(arg_error(
                        &child(path, "tag"),
                        format!("one of {name}'s cases ({})", union_cases(u)),
                        "nothing",
                    ));
                };
                let case = u
                    .cases
                    .iter()
                    .find(|c| case_name(c) == *tag)
                    .ok_or_else(|| {
                        arg_error(
                            &child(path, "tag"),
                            format!("one of {name}'s cases ({})", union_cases(u)),
                            format!("{tag:?}"),
                        )
                    })?;
                let mut items = vec![ScVal::Symbol(symbol(tag, path)?)];
                if let ScSpecUdtUnionCaseV0::TupleV0(t) = case {
                    let values = match obj.get("values") {
                        Some(Value::Array(values)) if values.len() == t.type_.len() => values,
                        Some(other) => {
                            return Err(arg_error(
                                &child(path, "values"),
                                format!("an array of {} values", t.type_.len()),
                                json_kind(other),
                            ))
                        }
                        None => {
                            return Err(arg_error(
                                &child(path, "values"),
                                format!("an array of {} values", t.type_.len()),
                                "nothing",
                            ))
                        }
                    };
                    for (i, (ty, x)) in t.type_.iter().zip(values).enumerate() {
                        items.push(self.encode(
                            ty,
                            x,
                            &index(&child(path, "values"), i),
                            depth + 1,
                        )?);
                    }
                }
                vec_of(items, path)?
            }
            ScSpecEntry::UdtEnumV0(e) => {
                let n: u32 = small_int(v, path, name)?;
                if !e.cases.iter().any(|c| c.value == n) {
                    let values = e
                        .cases
                        .iter()
                        .map(|c| format!("{}={}", c.name.to_utf8_string_lossy(), c.value))
                        .collect::<Vec<_>>()
                        .join(", ");
                    return Err(arg_error(
                        path,
                        format!("one of {name}'s values ({values})"),
                        n.to_string(),
                    ));
                }
                ScVal::U32(n)
            }
            ScSpecEntry::UdtErrorEnumV0(e) => {
                let n: u32 = small_int(v, path, name)?;
                if !e.cases.iter().any(|c| c.value == n) {
                    return Err(arg_error(
                        path,
                        format!("one of {name}'s codes"),
                        n.to_string(),
                    ));
                }
                ScVal::Error(ScError::Contract(n))
            }
            _ => return Err(LaneError::InvalidWasm(format!("`{name}` is not a type"))),
        })
    }
}

fn names(inputs: &[(String, &ScSpecTypeDef)]) -> String {
    inputs
        .iter()
        .map(|(n, _)| n.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn case_name(c: &ScSpecUdtUnionCaseV0) -> String {
    match c {
        ScSpecUdtUnionCaseV0::VoidV0(v) => v.name.to_utf8_string_lossy(),
        ScSpecUdtUnionCaseV0::TupleV0(t) => t.name.to_utf8_string_lossy(),
    }
}

fn union_cases(u: &soroban_env_host::xdr::ScSpecUdtUnionV0) -> String {
    u.cases.iter().map(case_name).collect::<Vec<_>>().join(", ")
}

fn vec_of(items: Vec<ScVal>, path: &str) -> Result<ScVal, LaneError> {
    Ok(ScVal::Vec(Some(ScVec(
        VecM::try_from(items).map_err(xdr_err(path, "a vector"))?,
    ))))
}

fn symbol(s: &str, path: &str) -> Result<ScSymbol, LaneError> {
    let ok = s.len() <= 32 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if !ok {
        return Err(arg_error(
            path,
            "Symbol (up to 32 of a-z, A-Z, 0-9 and _)",
            format!("{s:?}"),
        ));
    }
    Ok(ScSymbol(
        StringM::try_from(s.as_bytes().to_vec()).map_err(xdr_err(path, "Symbol"))?,
    ))
}

fn base64_bytes(v: &Value, path: &str, expected: &str) -> Result<Vec<u8>, LaneError> {
    use base64::Engine;
    match v {
        Value::String(s) => base64::engine::general_purpose::STANDARD
            .decode(s)
            .map_err(|_| {
                arg_error(
                    path,
                    expected.to_string(),
                    format!("{s:?}, which is not base64"),
                )
            }),
        _ => Err(mismatch(path, expected.to_string(), v)),
    }
}

fn small_int<T: TryFrom<i64> + TryFrom<u64>>(
    v: &Value,
    path: &str,
    what: &str,
) -> Result<T, LaneError> {
    let out_of_range = || {
        arg_error(
            path,
            what.to_string(),
            format!("{v}, which is out of range"),
        )
    };
    match v {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                T::try_from(u).map_err(|_| out_of_range())
            } else if let Some(i) = n.as_i64() {
                T::try_from(i).map_err(|_| out_of_range())
            } else {
                Err(arg_error(
                    path,
                    what.to_string(),
                    format!("{n}, which is not an integer"),
                ))
            }
        }
        // A digit string is accepted for the small widths too, so a value
        // typed on a command line needs no quoting rules per type.
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .ok()
            .and_then(|i| T::try_from(i).ok())
            .ok_or_else(|| arg_error(path, what.to_string(), format!("{s:?}"))),
        _ => Err(mismatch(path, what.to_string(), v)),
    }
}

fn big_int<T: FromStr + TryFrom<u64> + TryFrom<i64>>(
    v: &Value,
    path: &str,
    what: &str,
) -> Result<T, LaneError> {
    let expected = format!("{what} (a decimal string)");
    match v {
        Value::String(s) => s
            .parse::<T>()
            .map_err(|_| arg_error(path, expected.clone(), format!("{s:?}"))),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                T::try_from(u).map_err(|_| {
                    arg_error(
                        path,
                        expected.clone(),
                        format!("{n}, which is out of range"),
                    )
                })
            } else if let Some(i) = n.as_i64() {
                T::try_from(i).map_err(|_| {
                    arg_error(
                        path,
                        expected.clone(),
                        format!("{n}, which is out of range"),
                    )
                })
            } else {
                Err(arg_error(
                    path,
                    expected,
                    format!("{n}, which a JSON number cannot hold exactly"),
                ))
            }
        }
        _ => Err(mismatch(path, expected, v)),
    }
}

/// A decimal string (or exact JSON integer) as four big-endian u64 limbs.
fn parse_256(s: &str, path: &str, what: &str) -> Result<(bool, [u64; 4]), LaneError> {
    let expected = format!("{what} (a decimal string)");
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(arg_error(path, expected, format!("{s:?}")));
    }
    // Little-endian limbs while accumulating.
    let mut limbs = [0u64; 4];
    for b in digits.bytes() {
        let mut carry = u128::from(b - b'0');
        for limb in limbs.iter_mut() {
            let wide = u128::from(*limb) * 10 + carry;
            *limb = wide as u64;
            carry = wide >> 64;
        }
        if carry != 0 {
            return Err(arg_error(
                path,
                expected,
                format!("{s:?}, which is out of range"),
            ));
        }
    }
    limbs.reverse();
    Ok((negative, limbs))
}

fn number_text(v: &Value, path: &str, what: &str) -> Result<String, LaneError> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) if n.is_u64() || n.is_i64() => Ok(n.to_string()),
        _ => Err(mismatch(path, format!("{what} (a decimal string)"), v)),
    }
}

fn u256(v: &Value, path: &str) -> Result<[u64; 4], LaneError> {
    let s = number_text(v, path, "u256")?;
    let (negative, limbs) = parse_256(&s, path, "u256")?;
    if negative && limbs != [0; 4] {
        return Err(arg_error(
            path,
            "u256 (a decimal string)",
            format!("{s:?}, which is negative"),
        ));
    }
    Ok(limbs)
}

fn i256(v: &Value, path: &str) -> Result<[u64; 4], LaneError> {
    let s = number_text(v, path, "i256")?;
    let (negative, limbs) = parse_256(&s, path, "i256")?;
    let magnitude_limit = if negative {
        1u64 << 63
    } else {
        (1u64 << 63) - 1
    };
    let fits = limbs[0] < magnitude_limit
        || (limbs[0] == magnitude_limit && (!negative || limbs[1..] == [0, 0, 0]));
    if !fits {
        return Err(arg_error(
            path,
            "i256 (a decimal string)",
            format!("{s:?}, which is out of range"),
        ));
    }
    if !negative {
        return Ok(limbs);
    }
    // Two's complement of the magnitude.
    let mut out = [0u64; 4];
    let mut carry = 1u128;
    for i in (0..4).rev() {
        let wide = u128::from(!limbs[i]) + carry;
        out[i] = wide as u64;
        carry = wide >> 64;
    }
    Ok(out)
}

// ─── ScVal → JSON ──────────────────────────────────────────────────────────────

fn decode_error(path: &str, expected: &str, val: &ScVal) -> LaneError {
    LaneError::Decode(format!(
        "{}expected {expected}, got {}",
        if path.is_empty() {
            String::new()
        } else {
            format!("{path}: ")
        },
        val.name()
    ))
}

fn u256_text(limbs: [u64; 4]) -> String {
    // Repeated division by 10 over big-endian limbs.
    let mut n = limbs;
    if n == [0; 4] {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n != [0; 4] {
        let mut rem = 0u128;
        for limb in n.iter_mut() {
            let wide = (rem << 64) | u128::from(*limb);
            *limb = (wide / 10) as u64;
            rem = wide % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    digits.reverse();
    String::from_utf8(digits).expect("digits are ASCII")
}

fn i256_text(limbs: [u64; 4]) -> String {
    if limbs[0] >> 63 == 0 {
        return u256_text(limbs);
    }
    let mut mag = [0u64; 4];
    let mut carry = 1u128;
    for i in (0..4).rev() {
        let wide = u128::from(!limbs[i]) + carry;
        mag[i] = wide as u64;
        carry = wide >> 64;
    }
    format!("-{}", u256_text(mag))
}

fn b64(bytes: &[u8]) -> String {
    super::base64(bytes)
}

impl Spec {
    /// Decode a value as `ty`, into the same JSON shape [`Spec::encode`]
    /// accepts, so `decode(encode(x)) == x`.
    pub fn decode(
        &self,
        ty: &ScSpecTypeDef,
        val: &ScVal,
        path: &str,
        depth: usize,
    ) -> Result<Value, LaneError> {
        if depth > MAX_TYPE_DEPTH {
            return Err(LaneError::Decode(format!(
                "{path}: value nested deeper than 32"
            )));
        }
        Ok(match (ty, val) {
            (ScSpecTypeDef::Val, _) => generic(val)?,
            (ScSpecTypeDef::Bool, ScVal::Bool(b)) => json!(b),
            (ScSpecTypeDef::Void, ScVal::Void) => Value::Null,
            (ScSpecTypeDef::U32, ScVal::U32(n)) => json!(n),
            (ScSpecTypeDef::I32, ScVal::I32(n)) => json!(n),
            (ScSpecTypeDef::U64, ScVal::U64(n)) => json!(n.to_string()),
            (ScSpecTypeDef::I64, ScVal::I64(n)) => json!(n.to_string()),
            (ScSpecTypeDef::Timepoint, ScVal::Timepoint(t)) => json!(t.0.to_string()),
            (ScSpecTypeDef::Duration, ScVal::Duration(d)) => json!(d.0.to_string()),
            (ScSpecTypeDef::U128, ScVal::U128(p)) => {
                json!(((u128::from(p.hi) << 64) | u128::from(p.lo)).to_string())
            }
            (ScSpecTypeDef::I128, ScVal::I128(p)) => {
                json!(((i128::from(p.hi) << 64) | i128::from(p.lo)).to_string())
            }
            (ScSpecTypeDef::U256, ScVal::U256(p)) => {
                json!(u256_text([p.hi_hi, p.hi_lo, p.lo_hi, p.lo_lo]))
            }
            (ScSpecTypeDef::I256, ScVal::I256(p)) => {
                json!(i256_text([p.hi_hi as u64, p.hi_lo, p.lo_hi, p.lo_lo]))
            }
            (ScSpecTypeDef::Bytes | ScSpecTypeDef::BytesN(_), ScVal::Bytes(b)) => {
                json!(b64(b.as_slice()))
            }
            (ScSpecTypeDef::String, ScVal::String(s)) => json!(s.0.to_utf8_string_lossy()),
            (ScSpecTypeDef::Symbol, ScVal::Symbol(s)) => json!(s.0.to_utf8_string_lossy()),
            (ScSpecTypeDef::Address | ScSpecTypeDef::MuxedAddress, ScVal::Address(a)) => {
                json!(a.to_string())
            }
            (ScSpecTypeDef::Option(_), ScVal::Void) => Value::Null,
            (ScSpecTypeDef::Option(o), _) => self.decode(&o.value_type, val, path, depth + 1)?,
            (ScSpecTypeDef::Result(r), ScVal::Error(_)) => {
                self.decode(&r.error_type, val, path, depth + 1)?
            }
            (ScSpecTypeDef::Result(r), _) => self.decode(&r.ok_type, val, path, depth + 1)?,
            (ScSpecTypeDef::Vec(t), ScVal::Vec(Some(items))) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, x)| self.decode(&t.element_type, x, &index(path, i), depth + 1))
                    .collect::<Result<_, _>>()?,
            ),
            (ScSpecTypeDef::Tuple(t), ScVal::Vec(Some(items)))
                if items.len() == t.value_types.len() =>
            {
                Value::Array(
                    t.value_types
                        .iter()
                        .zip(items.iter())
                        .enumerate()
                        .map(|(i, (ty, x))| self.decode(ty, x, &index(path, i), depth + 1))
                        .collect::<Result<_, _>>()?,
                )
            }
            (ScSpecTypeDef::Map(m), ScVal::Map(Some(entries))) => Value::Array(
                entries
                    .iter()
                    .enumerate()
                    .map(|(i, e)| {
                        let at = index(path, i);
                        Ok(json!([
                            self.decode(&m.key_type, &e.key, &format!("{at}[0]"), depth + 1)?,
                            self.decode(&m.value_type, &e.val, &format!("{at}[1]"), depth + 1)?
                        ]))
                    })
                    .collect::<Result<_, LaneError>>()?,
            ),
            (ScSpecTypeDef::Udt(u), _) => {
                self.decode_udt(&u.name.to_utf8_string_lossy(), val, path, depth)?
            }
            (ScSpecTypeDef::Error, ScVal::Error(e)) => error_json(e),
            _ => return Err(decode_error(path, &type_name(ty), val)),
        })
    }

    fn decode_udt(
        &self,
        name: &str,
        val: &ScVal,
        path: &str,
        depth: usize,
    ) -> Result<Value, LaneError> {
        let Some(entry) = self.udt(name) else {
            return Err(LaneError::InvalidWasm(format!(
                "the spec names type `{name}` but does not define it"
            )));
        };
        Ok(match (entry, val) {
            (ScSpecEntry::UdtStructV0(s), ScVal::Vec(Some(items)))
                if !s.fields.is_empty()
                    && s.fields
                        .iter()
                        .all(|f| f.name.to_utf8_string_lossy().parse::<u32>().is_ok())
                    && items.len() == s.fields.len() =>
            {
                Value::Array(
                    s.fields
                        .iter()
                        .zip(items.iter())
                        .enumerate()
                        .map(|(i, (f, x))| self.decode(&f.type_, x, &index(path, i), depth + 1))
                        .collect::<Result<_, _>>()?,
                )
            }
            (ScSpecEntry::UdtStructV0(s), ScVal::Map(Some(entries))) => {
                let mut out = Map::new();
                for f in s.fields.iter() {
                    let field = f.name.to_utf8_string_lossy();
                    let at = child(path, &field);
                    let found = entries.iter().find(|e| matches!(&e.key, ScVal::Symbol(sym) if sym.0.to_utf8_string_lossy() == field));
                    match found {
                        Some(e) => {
                            out.insert(field, self.decode(&f.type_, &e.val, &at, depth + 1)?);
                        }
                        None if matches!(f.type_, ScSpecTypeDef::Option(_)) => {
                            out.insert(field, Value::Null);
                        }
                        None => {
                            return Err(LaneError::Decode(format!(
                                "{at}: field missing from {name}"
                            )))
                        }
                    }
                }
                Value::Object(out)
            }
            (ScSpecEntry::UdtUnionV0(u), ScVal::Vec(Some(items))) => {
                let Some(ScVal::Symbol(tag)) = items.first() else {
                    return Err(decode_error(
                        path,
                        &format!("{name} (a vector led by its case symbol)"),
                        val,
                    ));
                };
                let tag = tag.0.to_utf8_string_lossy();
                let case = u
                    .cases
                    .iter()
                    .find(|c| case_name(c) == tag)
                    .ok_or_else(|| {
                        LaneError::Decode(format!("{path}: {name} has no case `{tag}`"))
                    })?;
                match case {
                    ScSpecUdtUnionCaseV0::VoidV0(_) => json!({ "tag": tag }),
                    ScSpecUdtUnionCaseV0::TupleV0(t) => {
                        let rest = &items[1..];
                        if rest.len() != t.type_.len() {
                            return Err(LaneError::Decode(format!(
                                "{path}: {name}::{tag} carries {} values, not {}",
                                rest.len(),
                                t.type_.len()
                            )));
                        }
                        let at = child(path, "values");
                        let values = t
                            .type_
                            .iter()
                            .zip(rest)
                            .enumerate()
                            .map(|(i, (ty, x))| self.decode(ty, x, &index(&at, i), depth + 1))
                            .collect::<Result<Vec<_>, _>>()?;
                        json!({ "tag": tag, "values": values })
                    }
                }
            }
            (ScSpecEntry::UdtEnumV0(_), ScVal::U32(n)) => json!(n),
            (ScSpecEntry::UdtErrorEnumV0(_), ScVal::Error(ScError::Contract(n))) => json!(n),
            (ScSpecEntry::UdtErrorEnumV0(_), ScVal::U32(n)) => json!(n),
            _ => return Err(decode_error(path, name, val)),
        })
    }

    /// Decode a function's return value. A `Result` output that failed
    /// decodes to `{"error": …}` naming the error (see [`Spec::error_json`]).
    pub fn decode_return(&self, function: &str, val: &ScVal) -> Result<Value, LaneError> {
        let f = self
            .function(function)
            .ok_or_else(|| LaneError::InvalidInput {
                what: "function",
                detail: format!("the contract has no function `{function}`"),
            })?;
        match (f.outputs.first(), val) {
            (None, ScVal::Void) => Ok(Value::Null),
            (None, other) => Err(decode_error("", "void", other)),
            (Some(ScSpecTypeDef::Result(_)), ScVal::Error(e)) => {
                Ok(json!({ "error": self.error_json(e) }))
            }
            (Some(ty), _) => self.decode(ty, val, "", 0),
        }
    }

    /// Decode a value as the named type the spec defines.
    pub fn decode_as(&self, type_name: &str, val: &ScVal) -> Result<Value, LaneError> {
        if self.udt(type_name).is_none() {
            return Err(LaneError::InvalidInput {
                what: "type",
                detail: format!("the contract defines no type `{type_name}`"),
            });
        }
        let ty = ScSpecTypeDef::Udt(ScSpecTypeUdt {
            name: StringM::try_from(type_name.as_bytes().to_vec()).map_err(|_| {
                LaneError::InvalidInput {
                    what: "type",
                    detail: "names are at most 60 bytes".into(),
                }
            })?,
        });
        self.decode(&ty, val, "", 0)
    }

    /// An error as `{code, name, enum, doc}` from the spec's error enums.
    /// When the contract declares several enums with a case at this code,
    /// every one is listed under `candidates` and the first is used. A host
    /// error (a trap, the budget) is `{type, code}` in the host's terms.
    pub fn error_json(&self, e: &ScError) -> Value {
        let ScError::Contract(code) = e else {
            let (ty, code) = host_error_parts(e);
            return json!({ "type": ty, "code": code });
        };
        let cases = self.error_cases(*code);
        let case = |(en, name, doc): &(String, String, String)| json!({ "enum": en, "name": name, "doc": doc, "code": code });
        match cases.as_slice() {
            [] => json!({ "code": code }),
            [one] => case(one),
            [first, ..] => {
                let mut out = case(first);
                out["candidates"] = Value::Array(cases.iter().map(case).collect());
                out
            }
        }
    }

    /// A contract event: its topics and data generically, and, when the
    /// contract declares an event spec (`ScSpecEventV0`) whose prefix
    /// topics match, the event's name and its parameters decoded by type.
    pub fn decode_event(&self, event: &ContractEvent) -> Result<Value, LaneError> {
        let ContractEventBody::V0(body) = &event.body;
        let topics: Vec<Value> = body.topics.iter().map(generic).collect::<Result<_, _>>()?;
        let mut out = json!({
            "contract_id": event.contract_id.as_ref().map(|id| ScAddress::Contract(id.clone()).to_string()),
            "type": event.type_.name().to_lowercase(),
            "name": Value::Null,
            "topics": topics,
            "data": generic(&body.data)?,
        });
        let Some(spec) = self.entries.iter().find_map(|e| match e {
            ScSpecEntry::EventV0(ev) if prefix_matches(ev, &body.topics) => Some(ev),
            _ => None,
        }) else {
            return Ok(out);
        };
        out["name"] = json!(spec.name.to_utf8_string_lossy());
        let mut params = Map::new();
        let mut rest = body.topics.iter().skip(spec.prefix_topics.len());
        let data_params: Vec<_> = spec
            .params
            .iter()
            .filter(|p| p.location == ScSpecEventParamLocationV0::Data)
            .collect();
        for p in spec
            .params
            .iter()
            .filter(|p| p.location == ScSpecEventParamLocationV0::TopicList)
        {
            let name = p.name.to_utf8_string_lossy();
            let Some(topic) = rest.next() else {
                return Ok(out);
            };
            params.insert(name.clone(), self.decode(&p.type_, topic, &name, 0)?);
        }
        match spec.data_format {
            ScSpecEventDataFormat::SingleValue => {
                if let Some(p) = data_params.first() {
                    let name = p.name.to_utf8_string_lossy();
                    params.insert(name.clone(), self.decode(&p.type_, &body.data, &name, 0)?);
                }
            }
            ScSpecEventDataFormat::Vec => {
                if let ScVal::Vec(Some(items)) = &body.data {
                    for (p, item) in data_params.iter().zip(items.iter()) {
                        let name = p.name.to_utf8_string_lossy();
                        params.insert(name.clone(), self.decode(&p.type_, item, &name, 0)?);
                    }
                }
            }
            ScSpecEventDataFormat::Map => {
                if let ScVal::Map(Some(entries)) = &body.data {
                    for p in &data_params {
                        let name = p.name.to_utf8_string_lossy();
                        let found = entries.iter().find(|e| matches!(&e.key, ScVal::Symbol(s) if s.0.to_utf8_string_lossy() == name));
                        if let Some(e) = found {
                            params.insert(name.clone(), self.decode(&p.type_, &e.val, &name, 0)?);
                        }
                    }
                }
            }
        }
        out["params"] = Value::Object(params);
        Ok(out)
    }
}

fn error_json(e: &ScError) -> Value {
    match e {
        ScError::Contract(n) => json!(n),
        other => {
            let (ty, code) = host_error_parts(other);
            json!({ "type": ty, "code": code })
        }
    }
}

/// A host error's type and code in the host's own words
/// (`Error(Budget, ExceededLimit)` → `("Budget", "ExceededLimit")`).
pub fn host_error_parts(e: &ScError) -> (String, String) {
    match e {
        ScError::Contract(n) => ("Contract".into(), n.to_string()),
        ScError::WasmVm(c) => ("WasmVm".into(), c.name().into()),
        ScError::Context(c) => ("Context".into(), c.name().into()),
        ScError::Storage(c) => ("Storage".into(), c.name().into()),
        ScError::Object(c) => ("Object".into(), c.name().into()),
        ScError::Crypto(c) => ("Crypto".into(), c.name().into()),
        ScError::Events(c) => ("Events".into(), c.name().into()),
        ScError::Budget(c) => ("Budget".into(), c.name().into()),
        ScError::Value(c) => ("Value".into(), c.name().into()),
        ScError::Auth(c) => ("Auth".into(), c.name().into()),
    }
}

fn prefix_matches(ev: &soroban_env_host::xdr::ScSpecEventV0, topics: &[ScVal]) -> bool {
    !ev.prefix_topics.is_empty()
        && topics.len() >= ev.prefix_topics.len()
        && ev
            .prefix_topics
            .iter()
            .zip(topics)
            .all(|(want, got)| matches!(got, ScVal::Symbol(s) if s.0 == want.0))
}

/// A value with no declared type, decoded by its own shape: the same JSON
/// forms as above, with maps as `[key, value]` pairs.
pub fn generic(val: &ScVal) -> Result<Value, LaneError> {
    Ok(match val {
        ScVal::Bool(b) => json!(b),
        ScVal::Void => Value::Null,
        ScVal::U32(n) => json!(n),
        ScVal::I32(n) => json!(n),
        ScVal::U64(n) => json!(n.to_string()),
        ScVal::I64(n) => json!(n.to_string()),
        ScVal::Timepoint(t) => json!(t.0.to_string()),
        ScVal::Duration(d) => json!(d.0.to_string()),
        ScVal::U128(p) => json!(((u128::from(p.hi) << 64) | u128::from(p.lo)).to_string()),
        ScVal::I128(p) => json!(((i128::from(p.hi) << 64) | i128::from(p.lo)).to_string()),
        ScVal::U256(p) => json!(u256_text([p.hi_hi, p.hi_lo, p.lo_hi, p.lo_lo])),
        ScVal::I256(p) => json!(i256_text([p.hi_hi as u64, p.hi_lo, p.lo_hi, p.lo_lo])),
        ScVal::Bytes(b) => json!(b64(b.as_slice())),
        ScVal::String(s) => json!(s.0.to_utf8_string_lossy()),
        ScVal::Symbol(s) => json!(s.0.to_utf8_string_lossy()),
        ScVal::Address(a) => json!(a.to_string()),
        ScVal::Error(e) => error_json(e),
        ScVal::Vec(Some(items)) => {
            Value::Array(items.iter().map(generic).collect::<Result<_, _>>()?)
        }
        ScVal::Vec(None) => Value::Array(vec![]),
        ScVal::Map(Some(entries)) => Value::Array(
            entries
                .iter()
                .map(|e| Ok(json!([generic(&e.key)?, generic(&e.val)?])))
                .collect::<Result<_, LaneError>>()?,
        ),
        ScVal::Map(None) => Value::Array(vec![]),
        other => json!({ "type": other.name(), "xdr": b64(&encode(other, "ScVal")?) }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/../../packages/spec/fixtures/{name}.wasm",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn zoo() -> Spec {
        Spec::from_wasm(&fixture("types_zoo")).unwrap()
    }

    /// Encode `args` for `function`, then decode each value back with its
    /// declared type: the round trip must give the input back.
    fn round_trip(spec: &Spec, function: &str, args: Value) {
        let encoded = spec.encode_args(function, &args).unwrap();
        let f = spec.function(function).unwrap();
        for (input, val) in f.inputs.iter().zip(&encoded) {
            let name = input.name.to_utf8_string_lossy();
            let back = spec.decode(&input.type_, val, &name, 0).unwrap();
            let want = args.get(&name).cloned().unwrap_or(Value::Null);
            assert_eq!(back, want, "{function}.{name}");
        }
    }

    #[test]
    fn every_integer_width_round_trips_at_its_limits() {
        let spec = zoo();
        round_trip(
            &spec,
            "ints",
            json!({
                "a": 4294967295u32, "b": -2147483648i32,
                "c": "18446744073709551615", "d": "-9223372036854775808",
                "e": "340282366920938463463374607431768211455",
                "f": "-170141183460469231731687303715884105728",
                "g": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
                "h": "-57896044618658097711785492504343953926634992332820282019728792003956564819968",
            }),
        );
        round_trip(
            &spec,
            "ints",
            json!({ "a": 0, "b": 0, "c": "0", "d": "0", "e": "0", "f": "-1", "g": "1", "h": "-1" }),
        );
    }

    #[test]
    fn primitives_round_trip() {
        let spec = zoo();
        round_trip(&spec, "flip", json!({ "v": true }));
        round_trip(
            &spec,
            "blobs",
            json!({ "s": "héllo", "sym": "hello_1", "b": "AAEC", "fixed": BASE64_32 }),
        );
        round_trip(
            &spec,
            "who",
            json!({ "who": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }),
        );
        round_trip(
            &spec,
            "who",
            json!({ "who": "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN" }),
        );
        round_trip(&spec, "when", json!({ "at": "1790000000", "lasts": "60" }));
    }

    const BASE64_32: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    #[test]
    fn containers_and_user_types_round_trip() {
        let spec = zoo();
        round_trip(&spec, "maybe", json!({ "v": 5 }));
        round_trip(&spec, "maybe", json!({ "v": null }));
        round_trip(&spec, "fallible", json!({ "v": 3 }));
        round_trip(&spec, "many", json!({ "v": [1, 2, 3] }));
        round_trip(&spec, "many", json!({ "v": [] }));
        round_trip(&spec, "pair", json!({ "p": [7, "seven"] }));
        round_trip(&spec, "lookup", json!({ "m": [["a", 1], ["b", 2]] }));
        round_trip(
            &spec,
            "nested",
            json!({ "v": { "inner": { "inner": { "value": 9 } } } }),
        );
        round_trip(&spec, "paint", json!({ "c": 2 }));
        round_trip(
            &spec,
            "shape",
            json!({ "s": { "tag": "Point", "values": [1, 2] } }),
        );
        round_trip(&spec, "shape", json!({ "s": { "tag": "Empty" } }));
    }

    #[test]
    fn a_left_out_option_is_void_and_args_may_be_positional() {
        let spec = zoo();
        assert_eq!(
            spec.encode_args("maybe", &json!({})).unwrap(),
            vec![ScVal::Void]
        );
        let named = spec.encode_args("pair", &json!({ "p": [1, "x"] })).unwrap();
        let positional = spec.encode_args("pair", &json!([[1, "x"]])).unwrap();
        assert_eq!(named, positional);
    }

    #[test]
    fn map_keys_are_sorted_and_an_object_is_accepted_for_symbol_keys() {
        let spec = zoo();
        let from_pairs = spec
            .encode_args("lookup", &json!({ "m": [["b", 2], ["a", 1]] }))
            .unwrap();
        let from_object = spec
            .encode_args("lookup", &json!({ "m": { "b": 2, "a": 1 } }))
            .unwrap();
        assert_eq!(from_pairs, from_object);
        let ScVal::Map(Some(m)) = &from_pairs[0] else {
            panic!()
        };
        assert_eq!(m[0].key, ScVal::Symbol(ScSymbol("a".try_into().unwrap())));
    }

    fn err(spec: &Spec, function: &str, args: Value) -> String {
        spec.encode_args(function, &args).unwrap_err().to_string()
    }

    #[test]
    fn a_wrong_type_names_the_path_and_what_was_expected() {
        let registry = Spec::from_wasm(&fixture("identity-registry")).unwrap();
        assert_eq!(
            err(
                &registry,
                "claim",
                json!({ "handle": "alice", "wallet": 5 })
            ),
            "wallet: expected Address (G… or C…), got number"
        );

        let zoo = zoo();
        assert_eq!(
            err(&zoo, "many", json!({ "v": [1, 2, true] })),
            "v[2]: expected u32, got boolean"
        );
        assert_eq!(
            err(
                &zoo,
                "nested",
                json!({ "v": { "inner": { "inner": { "value": "x" } } } })
            ),
            "v.inner.inner.value: expected u32, got \"x\""
        );
        assert_eq!(
            err(&zoo, "nested", json!({ "v": { "inner": { "inner": {} } } })),
            "v.inner.inner.value: expected u32, got nothing (the field is missing)"
        );
        assert!(err(
            &zoo,
            "ints",
            json!({ "a": -1, "b": 0, "c": "0", "d": "0", "e": "0", "f": "0", "g": "0", "h": "0" })
        )
        .starts_with("a: expected u32, got -1, which is out of range"));
        assert!(err(
            &zoo,
            "blobs",
            json!({ "s": "", "sym": "s", "b": "", "fixed": "AAEC" })
        )
        .starts_with("fixed: expected BytesN<32>"));
        assert!(err(&zoo, "shape", json!({ "s": { "tag": "Circle" } }))
            .starts_with("s.tag: expected one of Shape's cases (Point, Empty)"));
        assert!(err(&zoo, "paint", json!({ "c": 3 }))
            .starts_with("c: expected one of Color's values (Red=1, Green=2)"));
        assert!(err(&zoo, "pair", json!({ "p": [1] }))
            .starts_with("p: expected (u32, Symbol) (array of 2)"));
        assert!(err(
            &zoo,
            "blobs",
            json!({ "s": "", "sym": "has space", "b": "", "fixed": BASE64_32 })
        )
        .starts_with("sym: expected Symbol"));
        assert!(err(&zoo, "flip", json!({ "v": true, "extra": 1 }))
            .starts_with("extra: expected one of `flip`'s arguments (v)"));
        assert!(err(&zoo, "flip", json!({})).starts_with("v: expected bool, got nothing"));
        assert!(err(
            &zoo,
            "ints",
            json!({ "a": 0, "b": 0, "c": 1e30, "d": "0", "e": "0", "f": "0", "g": "0", "h": "0" })
        )
        .ends_with("which a JSON number cannot hold exactly"));
        assert!(matches!(
            zoo.encode_args("nope", &json!({})),
            Err(LaneError::InvalidInput {
                what: "function",
                ..
            })
        ));
    }

    #[test]
    fn i256_and_u256_reject_out_of_range_values() {
        let zoo = zoo();
        let ints = |g: &str, h: &str| json!({ "a": 0, "b": 0, "c": "0", "d": "0", "e": "0", "f": "0", "g": g, "h": h });
        assert!(err(
            &zoo,
            "ints",
            ints(
                "115792089237316195423570985008687907853269984665640564039457584007913129639936",
                "0"
            )
        )
        .starts_with("g:"));
        assert!(err(&zoo, "ints", ints("-1", "0")).starts_with("g:"));
        assert!(err(
            &zoo,
            "ints",
            ints(
                "0",
                "57896044618658097711785492504343953926634992332820282019728792003956564819968"
            )
        )
        .starts_with("h:"));
    }

    #[test]
    fn the_spec_document_matches_the_ts_readers_shape() {
        let wasm = fixture("types_zoo");
        let doc = spec_json(&wasm).unwrap();
        assert_eq!(doc["schemaVersion"], 1);
        assert_eq!(
            doc["wasmHash"],
            "02ef70d0c788ab498217f3f38d234575a01622d9c166af443c7d8dc6a245ab7d"
        );
        let fns: Vec<&str> = doc["functions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect();
        assert_eq!(fns.len(), 14, "{fns:?}");
        let ints = doc["functions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "ints")
            .unwrap();
        assert_eq!(
            ints["inputs"][7],
            json!({ "name": "h", "doc": "", "type": "i256" })
        );
        assert_eq!(ints["isConstructor"], false);
        let blobs = doc["functions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "blobs")
            .unwrap();
        assert_eq!(
            blobs["inputs"][3]["type"],
            json!({ "type": "bytes_n", "n": 32 })
        );
        let shape = doc["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "Shape")
            .unwrap();
        assert_eq!(shape["kind"], "union");
        assert_eq!(
            shape["cases"][0]["fields"][1],
            json!({ "name": "1", "type": "u32" })
        );
        assert_eq!(doc["errors"][0]["enumName"], "ZooError");
        assert_eq!(doc["errors"][0]["name"], "OutOfRange");
        assert_eq!(doc["errors"][0]["value"], 1);
        assert!(doc["env"]["protocolVersion"].as_u64().unwrap() > 0);
        assert!(doc["build"]["entries"].is_object());
        assert_eq!(doc["events"], json!([]));
        assert_eq!(
            doc["entriesXdr"].as_array().unwrap().len(),
            Spec::from_wasm(&wasm).unwrap().entries.len()
        );
    }

    #[test]
    fn a_module_over_the_size_cap_is_refused() {
        let wasm = fixture("adversarial/over_size_cap");
        assert!(
            matches!(Spec::from_wasm(&wasm), Err(LaneError::InvalidWasm(m)) if m.contains("exceeds maximum"))
        );
    }

    #[test]
    fn error_codes_resolve_to_every_matching_case() {
        let spec = Spec::from_wasm(&fixture("errors_multi")).unwrap();
        let cases = spec.error_cases(1);
        assert!(cases.len() >= 2, "{cases:?}");
        let registry = Spec::from_wasm(&fixture("identity-registry")).unwrap();
        assert_eq!(registry.error_cases(3)[0].1, "HandleTaken");
    }

    #[test]
    fn a_taken_handle_decodes_to_its_error_name() {
        let registry = Spec::from_wasm(&fixture("identity-registry")).unwrap();
        let got = registry
            .decode_return("claim", &ScVal::Error(ScError::Contract(3)))
            .unwrap();
        assert_eq!(got["error"]["name"], "HandleTaken");
        assert_eq!(got["error"]["code"], 3);
        assert_eq!(got["error"]["enum"], "Error");
        assert!(got["error"]["doc"].is_string());
        assert!(got["error"].get("candidates").is_none());
        // A successful claim returns void.
        assert_eq!(
            registry.decode_return("claim", &ScVal::Void).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn a_code_shared_by_two_error_enums_lists_both() {
        let spec = Spec::from_wasm(&fixture("errors_multi")).unwrap();
        let got = spec.error_json(&ScError::Contract(1));
        let names: Vec<&str> = got["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"Missing") && names.contains(&"Denied"),
            "{got}"
        );
    }

    #[test]
    fn a_host_error_keeps_the_hosts_terms() {
        use soroban_env_host::xdr::ScErrorCode;
        let spec = zoo();
        assert_eq!(
            spec.error_json(&ScError::Budget(ScErrorCode::ExceededLimit)),
            json!({ "type": "Budget", "code": "ExceededLimit" })
        );
    }

    #[test]
    fn events_decode_by_their_spec() {
        use soroban_env_host::xdr::{
            ContractEventType, ContractEventV0, ContractId, ExtensionPoint, Hash,
        };
        let spec = Spec::from_wasm(&fixture("events")).unwrap();
        let from = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
        let to = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN";
        let addr = |s: &str| ScVal::Address(ScAddress::from_str(s).unwrap());
        let sym = |s: &str| ScVal::Symbol(ScSymbol(s.try_into().unwrap()));
        let amount = ScVal::I128(Int128Parts { hi: 0, lo: 250 });
        let data = ScVal::Map(Some(
            ScMap::sorted_from(vec![ScMapEntry {
                key: sym("amount"),
                val: amount.clone(),
            }])
            .unwrap(),
        ));
        let event = ContractEvent {
            ext: ExtensionPoint::V0,
            contract_id: Some(ContractId(Hash([7; 32]))),
            type_: ContractEventType::Contract,
            body: ContractEventBody::V0(ContractEventV0 {
                topics: vec![sym("transfer"), addr(from), addr(to)]
                    .try_into()
                    .unwrap(),
                data: data.clone(),
            }),
        };
        let got = spec.decode_event(&event).unwrap();
        assert_eq!(got["name"], "Transfer", "{got}");
        assert_eq!(
            got["params"],
            json!({ "from": from, "to": to, "amount": "250" })
        );
        assert_eq!(got["type"], "contract");

        // An event no spec entry matches still decodes generically.
        let other = ContractEvent {
            body: ContractEventBody::V0(ContractEventV0 {
                topics: vec![sym("mystery")].try_into().unwrap(),
                data,
            }),
            ..event
        };
        let got = spec.decode_event(&other).unwrap();
        assert_eq!(got["name"], Value::Null);
        assert_eq!(got["topics"], json!(["mystery"]));
        assert_eq!(got["data"], json!([["amount", "250"]]));
        assert!(got.get("params").is_none());
    }

    /// A small deterministic generator, so the property test needs no
    /// dependency and fails the same way every time.
    struct Gen(u64);

    impl Gen {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
        fn digits(&mut self, max_len: u64, negative: bool) -> String {
            let len = 1 + self.below(max_len);
            let mut s: String = (0..len)
                .map(|_| char::from(b'0' + self.below(10) as u8))
                .collect();
            s = s.trim_start_matches('0').to_string();
            if s.is_empty() {
                return "0".into();
            }
            if negative && self.below(2) == 0 {
                s.insert(0, '-');
            }
            s
        }
        fn bytes(&mut self, n: usize) -> String {
            let raw: Vec<u8> = (0..n).map(|_| self.next() as u8).collect();
            super::super::base64(&raw)
        }
        fn word(&mut self) -> String {
            let len = 1 + self.below(8);
            (0..len)
                .map(|_| char::from(b'a' + self.below(26) as u8))
                .collect()
        }

        /// A JSON value `spec` accepts for `ty`, in the canonical form
        /// decoding produces.
        fn value(&mut self, spec: &Spec, ty: &ScSpecTypeDef, depth: usize) -> Value {
            let shallow = depth > 4;
            match ty {
                ScSpecTypeDef::Bool => json!(self.below(2) == 0),
                ScSpecTypeDef::Void => Value::Null,
                ScSpecTypeDef::U32 => json!(self.next() as u32),
                ScSpecTypeDef::I32 => json!(self.next() as i32),
                ScSpecTypeDef::U64 | ScSpecTypeDef::Timepoint | ScSpecTypeDef::Duration => {
                    json!(self.next().to_string())
                }
                ScSpecTypeDef::I64 => json!((self.next() as i64).to_string()),
                ScSpecTypeDef::U128 => {
                    json!(((u128::from(self.next()) << 64) | u128::from(self.next())).to_string())
                }
                ScSpecTypeDef::I128 => json!((((u128::from(self.next()) << 64)
                    | u128::from(self.next()))
                    as i128)
                    .to_string()),
                ScSpecTypeDef::U256 => json!(self.digits(77, false)),
                ScSpecTypeDef::I256 => json!(self.digits(76, true)),
                ScSpecTypeDef::Bytes => {
                    let n = self.below(12) as usize;
                    json!(self.bytes(n))
                }
                ScSpecTypeDef::BytesN(b) => json!(self.bytes(b.n as usize)),
                ScSpecTypeDef::String => json!(format!("{} ü", self.word())),
                ScSpecTypeDef::Symbol => json!(self.word()),
                ScSpecTypeDef::Address | ScSpecTypeDef::MuxedAddress => {
                    let pick = [
                        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                        "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN",
                    ];
                    json!(pick[self.below(2) as usize])
                }
                ScSpecTypeDef::Option(o) => {
                    if shallow || self.below(3) == 0 {
                        Value::Null
                    } else {
                        self.value(spec, &o.value_type, depth + 1)
                    }
                }
                ScSpecTypeDef::Result(r) => self.value(spec, &r.ok_type, depth + 1),
                ScSpecTypeDef::Vec(v) => {
                    let n = if shallow { 0 } else { self.below(4) };
                    Value::Array(
                        (0..n)
                            .map(|_| self.value(spec, &v.element_type, depth + 1))
                            .collect(),
                    )
                }
                ScSpecTypeDef::Tuple(t) => Value::Array(
                    t.value_types
                        .iter()
                        .map(|e| self.value(spec, e, depth + 1))
                        .collect(),
                ),
                ScSpecTypeDef::Map(m) => {
                    let n = if shallow { 0 } else { self.below(4) };
                    let mut pairs: Vec<(ScVal, Value)> = Vec::new();
                    for _ in 0..n {
                        let k = self.value(spec, &m.key_type, depth + 1);
                        let encoded = spec.encode(&m.key_type, &k, "k", 0).unwrap();
                        if pairs.iter().any(|(e, _)| *e == encoded) {
                            continue;
                        }
                        let v = self.value(spec, &m.value_type, depth + 1);
                        pairs.push((encoded, json!([k, v])));
                    }
                    pairs.sort_by(|a, b| a.0.cmp(&b.0));
                    Value::Array(pairs.into_iter().map(|(_, p)| p).collect())
                }
                ScSpecTypeDef::Udt(u) => {
                    let name = u.name.to_utf8_string_lossy();
                    match spec.udt(&name).unwrap() {
                        ScSpecEntry::UdtStructV0(st) => {
                            let tuple = st
                                .fields
                                .iter()
                                .all(|f| f.name.to_utf8_string_lossy().parse::<u32>().is_ok());
                            if tuple {
                                Value::Array(
                                    st.fields
                                        .iter()
                                        .map(|f| self.value(spec, &f.type_, depth + 1))
                                        .collect(),
                                )
                            } else {
                                Value::Object(
                                    st.fields
                                        .iter()
                                        .map(|f| {
                                            (
                                                f.name.to_utf8_string_lossy(),
                                                self.value(spec, &f.type_, depth + 1),
                                            )
                                        })
                                        .collect(),
                                )
                            }
                        }
                        ScSpecEntry::UdtUnionV0(un) => {
                            let case = &un.cases[self.below(un.cases.len() as u64) as usize];
                            match case {
                                ScSpecUdtUnionCaseV0::VoidV0(v) => {
                                    json!({ "tag": v.name.to_utf8_string_lossy() })
                                }
                                ScSpecUdtUnionCaseV0::TupleV0(t) => json!({
                                    "tag": t.name.to_utf8_string_lossy(),
                                    "values": t.type_.iter().map(|ty| self.value(spec, ty, depth + 1)).collect::<Vec<_>>(),
                                }),
                            }
                        }
                        ScSpecEntry::UdtEnumV0(e) => {
                            json!(e.cases[self.below(e.cases.len() as u64) as usize].value)
                        }
                        ScSpecEntry::UdtErrorEnumV0(e) => {
                            json!(e.cases[self.below(e.cases.len() as u64) as usize].value)
                        }
                        _ => unreachable!(),
                    }
                }
                ScSpecTypeDef::Val | ScSpecTypeDef::Error => Value::Null,
            }
        }
    }

    #[test]
    fn decode_of_encode_is_the_identity_for_generated_values() {
        let mut gen = Gen(0x5eed_5eed_5eed_5eed);
        let mut checked = 0;
        for name in [
            "types_zoo",
            "identity-registry",
            "errors_multi",
            "events",
            "undocumented",
        ] {
            let spec = Spec::from_wasm(&fixture(name)).unwrap();
            for f in spec.entries.iter().filter_map(|e| match e {
                ScSpecEntry::FunctionV0(f) => Some(f),
                _ => None,
            }) {
                for input in f.inputs.iter() {
                    if matches!(input.type_, ScSpecTypeDef::Val | ScSpecTypeDef::Error) {
                        continue;
                    }
                    for _ in 0..50 {
                        let x = gen.value(&spec, &input.type_, 0);
                        let val = spec.encode(&input.type_, &x, "x", 0).unwrap_or_else(|e| {
                            panic!("{name}.{}: encode {x}: {e}", f.name.to_utf8_string_lossy())
                        });
                        let back = spec.decode(&input.type_, &val, "x", 0).unwrap();
                        assert_eq!(
                            back,
                            x,
                            "{name}.{}({})",
                            f.name.to_utf8_string_lossy(),
                            input.name.to_utf8_string_lossy()
                        );
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 500, "only {checked} values checked");
    }
}
