//! `spec_diff` (#570): the deployed and the new executable's interfaces
//! compared, every change classed `breaking`, `compatible` or `info`.
//!
//! The comparison is `@signet/spec`'s `diffSpecs` (packages/spec/src/diff.ts)
//! over the same flattened `SpecJson` views, so the two agree on what
//! changed and whether it breaks clients; the conformance suite (#547)
//! holds them to it. On top of it this verb adds what the TS reader cannot
//! know:
//!
//! - A struct field added is breaking for values already stored, which
//!   decode without it and trap, unless the new build reads structs through
//!   CAP-86's sparse unpack (it imports `sparse_map_unpack_to_linear_memory`,
//!   `m.c`) and the field is an `Option`: a missing key then reads as
//!   `None`. Each such change names the rule that applied (`rule`), and the
//!   SDK versions from `contractmetav0` are reported. This is the one
//!   documented difference from the TS reader, which calls every added field
//!   breaking (sandbox/conformance/KNOWN_DIFFERENCES.md).
//! - Build and interface meta (`rssdkver`, the env interface version) are
//!   `info`.

use serde_json::{json, Map, Value};

/// The host function CAP-86's sparse struct decoding imports:
/// `sparse_map_unpack_to_linear_memory`, export `c` of module `m`.
pub const SPARSE_UNPACK: (&str, &str) = ("m", "c");

/// One change, as `diffSpecs` reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub kind: &'static str,
    pub path: String,
    pub breaking: bool,
    pub reason: &'static str,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

struct Diff {
    changes: Vec<Change>,
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

impl Diff {
    fn emit(
        &mut self,
        kind: &'static str,
        path: String,
        breaking: bool,
        reason: &'static str,
        before: Option<&Value>,
        after: Option<&Value>,
    ) {
        self.changes.push(Change {
            kind,
            path,
            breaking,
            reason,
            before: before.cloned(),
            after: after.cloned(),
        });
    }

    /// `docs`: an `undefined` doc and an empty one differ in TS only when one
    /// side lacks the key; the Rust reader always writes it, as the TS one
    /// does for parsed specs.
    fn docs(&mut self, path: String, before: Option<&Value>, after: Option<&Value>) {
        if before != after {
            self.emit(
                "documentation-changed",
                path,
                false,
                "Documentation changes do not alter the call interface.",
                before,
                after,
            );
        }
    }

    fn fields(&mut self, before: &[Value], after: &[Value], path: &str, args: bool) {
        for i in 0..before.len().max(after.len()) {
            match (before.get(i), after.get(i)) {
                (None, Some(b)) => self.emit(
                    if args {
                        "argument-added"
                    } else {
                        "field-added"
                    },
                    format!("{path}.{}", text(b, "name")),
                    true,
                    if args {
                        "Adding an argument changes the function signature."
                    } else {
                        "Adding a field changes the declared data shape."
                    },
                    None,
                    Some(b),
                ),
                (Some(a), None) => self.emit(
                    if args {
                        "argument-removed"
                    } else {
                        "field-removed"
                    },
                    format!("{path}.{}", text(a, "name")),
                    true,
                    if args {
                        "Removing an argument changes the function signature."
                    } else {
                        "Removing a field changes the declared data shape."
                    },
                    Some(a),
                    None,
                ),
                (Some(a), Some(b)) => {
                    if a.get("name") != b.get("name") {
                        self.emit(
                            if args {
                                "argument-renamed"
                            } else {
                                "field-renamed"
                            },
                            format!("{path}[{i}]"),
                            true,
                            if args {
                                "Renaming an argument can break clients binding by name."
                            } else {
                                "Renaming a field can break clients referencing it by name."
                            },
                            a.get("name"),
                            b.get("name"),
                        );
                    }
                    if a.get("type") != b.get("type") {
                        self.emit(
                            if args {
                                "argument-retyped"
                            } else {
                                "field-retyped"
                            },
                            format!("{path}[{i}]"),
                            true,
                            if args {
                                "Changing an argument type can break existing callers."
                            } else {
                                "Changing a field type can break existing consumers."
                            },
                            a.get("type"),
                            b.get("type"),
                        );
                    }
                    self.docs(format!("{path}[{i}].doc"), a.get("doc"), b.get("doc"));
                }
                (None, None) => {}
            }
        }
    }

    /// A struct's fields by name: a struct is a map keyed by field name, so
    /// position is not a change and a rename is a removal and an addition.
    fn struct_fields(&mut self, before: &[Value], after: &[Value], path: &str) {
        let find =
            |list: &[Value], name: &str| list.iter().find(|f| text(f, "name") == name).cloned();
        for a in before {
            if find(after, text(a, "name")).is_none() {
                self.emit(
                    "field-removed",
                    format!("{path}.{}", text(a, "name")),
                    true,
                    "Removing a field changes the declared data shape.",
                    Some(a),
                    None,
                );
            }
        }
        for b in after {
            let at = format!("{path}.{}", text(b, "name"));
            let Some(a) = find(before, text(b, "name")) else {
                self.emit(
                    "field-added",
                    at,
                    true,
                    "Adding a field changes the declared data shape.",
                    None,
                    Some(b),
                );
                continue;
            };
            if a.get("type") != b.get("type") {
                self.emit(
                    "field-retyped",
                    at.clone(),
                    true,
                    "Changing a field type can break existing consumers.",
                    a.get("type"),
                    b.get("type"),
                );
            }
            self.docs(format!("{at}.doc"), a.get("doc"), b.get("doc"));
        }
    }

    fn functions(&mut self, before: &[Value], after: &[Value]) {
        let find =
            |list: &[Value], name: &str| list.iter().find(|f| text(f, "name") == name).cloned();
        for old in before {
            if find(after, text(old, "name")).is_none() {
                self.emit(
                    "function-removed",
                    format!("functions.{}", text(old, "name")),
                    true,
                    "Removing a function breaks clients that call it.",
                    Some(old),
                    None,
                );
            }
        }
        for next in after {
            if find(before, text(next, "name")).is_none() {
                self.emit(
                    "function-added",
                    format!("functions.{}", text(next, "name")),
                    false,
                    "Adding a function does not invalidate existing calls.",
                    None,
                    Some(next),
                );
            }
        }
        for old in before {
            let Some(next) = find(after, text(old, "name")) else {
                continue;
            };
            let path = format!("functions.{}", text(old, "name"));
            self.fields(
                list(old, "inputs"),
                list(&next, "inputs"),
                &format!("{path}.inputs"),
                true,
            );
            if old.get("outputs") != next.get("outputs") {
                self.emit(
                    "return-type-changed",
                    format!("{path}.outputs"),
                    true,
                    "Changing return types can break clients expecting the previous result.",
                    old.get("outputs"),
                    next.get("outputs"),
                );
            }
            self.docs(format!("{path}.doc"), old.get("doc"), next.get("doc"));
        }
    }

    fn types(&mut self, before: &[Value], after: &[Value]) {
        let find =
            |list: &[Value], name: &str| list.iter().find(|t| text(t, "name") == name).cloned();
        for old in before {
            if find(after, text(old, "name")).is_none() {
                self.emit(
                    "type-removed",
                    format!("types.{}", text(old, "name")),
                    true,
                    "Removing a type can break declarations that depend on it.",
                    Some(old),
                    None,
                );
            }
        }
        for next in after {
            if find(before, text(next, "name")).is_none() {
                self.emit(
                    "type-added",
                    format!("types.{}", text(next, "name")),
                    false,
                    "Adding a type does not invalidate existing declarations.",
                    None,
                    Some(next),
                );
            }
        }
        for old in before {
            let Some(next) = find(after, text(old, "name")) else {
                continue;
            };
            let path = format!("types.{}", text(old, "name"));
            if old.get("kind") != next.get("kind") {
                self.emit(
                    "type-changed",
                    path,
                    true,
                    "Changing a type kind changes its declared interface.",
                    old.get("kind"),
                    next.get("kind"),
                );
                continue;
            }
            self.docs(format!("{path}.doc"), old.get("doc"), next.get("doc"));
            match text(old, "kind") {
                "struct" => self.struct_fields(
                    list(old, "fields"),
                    list(&next, "fields"),
                    &format!("{path}.fields"),
                ),
                "union" => self.cases(&path, list(old, "cases"), list(&next, "cases")),
                "enum" => self.variants(&path, list(old, "variants"), list(&next, "variants")),
                _ => {}
            }
        }
    }

    fn cases(&mut self, path: &str, before: &[Value], after: &[Value]) {
        let find =
            |list: &[Value], name: &str| list.iter().find(|c| text(c, "name") == name).cloned();
        for c in before {
            if find(after, text(c, "name")).is_none() {
                self.emit(
                    "case-removed",
                    format!("{path}.cases.{}", text(c, "name")),
                    true,
                    "Removing a union case can break consumers handling that case.",
                    Some(c),
                    None,
                );
            }
        }
        for c in after {
            if find(before, text(c, "name")).is_none() {
                self.emit(
                    "case-added",
                    format!("{path}.cases.{}", text(c, "name")),
                    true,
                    "Adding a union case can break exhaustive consumers.",
                    None,
                    Some(c),
                );
            }
        }
        for c in before {
            let Some(n) = find(after, text(c, "name")) else {
                continue;
            };
            let at = format!("{path}.cases.{}", text(c, "name"));
            self.docs(format!("{at}.doc"), c.get("doc"), n.get("doc"));
            self.fields(
                list(c, "fields"),
                list(&n, "fields"),
                &format!("{at}.fields"),
                false,
            );
        }
    }

    fn variants(&mut self, path: &str, before: &[Value], after: &[Value]) {
        let find =
            |list: &[Value], name: &str| list.iter().find(|v| text(v, "name") == name).cloned();
        for v in before {
            if find(after, text(v, "name")).is_none() {
                self.emit(
                    "variant-removed",
                    format!("{path}.variants.{}", text(v, "name")),
                    true,
                    "Removing an enum variant can break clients referencing it.",
                    Some(v),
                    None,
                );
            }
        }
        for v in after {
            let at = format!("{path}.variants.{}", text(v, "name"));
            let Some(previous) = find(before, text(v, "name")) else {
                self.emit(
                    "variant-added",
                    at,
                    true,
                    "Adding an enum variant can break exhaustive consumers.",
                    None,
                    Some(v),
                );
                continue;
            };
            if previous.get("value") != v.get("value") {
                self.emit(
                    "variant-renumbered",
                    at.clone(),
                    true,
                    "Changing a variant value breaks clients relying on its numeric value.",
                    previous.get("value"),
                    v.get("value"),
                );
            }
            self.docs(format!("{at}.doc"), previous.get("doc"), v.get("doc"));
        }
    }

    fn errors(&mut self, before: &[Value], after: &[Value]) {
        let key = |e: &Value| format!("{}.{}", text(e, "enumName"), text(e, "name"));
        let find = |list: &[Value], k: &str| list.iter().find(|e| key(e) == k).cloned();
        for old in before {
            let k = key(old);
            let Some(next) = find(after, &k) else {
                self.emit(
                    "error-removed",
                    format!("errors.{k}"),
                    true,
                    "Removing an error case can break existing error handling.",
                    Some(old),
                    None,
                );
                continue;
            };
            if old.get("value") != next.get("value") {
                self.emit(
                    "error-renumbered",
                    format!("errors.{k}"),
                    true,
                    "Changing an error value breaks clients matching its numeric code.",
                    old.get("value"),
                    next.get("value"),
                );
            }
            self.docs(format!("errors.{k}.doc"), old.get("doc"), next.get("doc"));
        }
        for next in after {
            let k = key(next);
            if find(before, &k).is_none() {
                self.emit(
                    "error-added",
                    format!("errors.{k}"),
                    false,
                    "Adding an error preserves existing error identifiers and values.",
                    None,
                    Some(next),
                );
            }
        }
    }
}

/// `diffSpecs`, over two `SpecJson` documents.
pub fn diff_specs(before: &Value, after: &Value) -> Vec<Change> {
    let mut d = Diff {
        changes: Vec::new(),
    };
    d.functions(list(before, "functions"), list(after, "functions"));
    d.types(list(before, "types"), list(after, "types"));
    d.errors(list(before, "errors"), list(after, "errors"));
    if before.get("events") != after.get("events") {
        d.emit(
            "event-changed",
            "events".into(),
            true,
            "Changing contract events can break clients that depend on their names, parameters, topics, or data format.",
            before.get("events"),
            after.get("events"),
        );
    }
    let empty = |v: &Value| {
        ["functions", "types", "errors"]
            .iter()
            .all(|k| list(v, k).is_empty())
    };
    if empty(before) && empty(after) && before.get("entriesXdr") != after.get("entriesXdr") {
        d.emit(
            "spec-entries-changed",
            "entriesXdr".into(),
            true,
            "Raw contract spec entries differ; detailed interface comparison requires flattened parser views.",
            before.get("entriesXdr"),
            after.get("entriesXdr"),
        );
    }
    d.changes
}

/// Whether a struct field's `TypeRef` is an `Option`.
fn is_option(field: Option<&Value>) -> bool {
    field
        .and_then(|f| f.get("type"))
        .and_then(|t| t.get("type"))
        .and_then(Value::as_str)
        == Some("option")
}

fn sdk_version(spec: &Value) -> Value {
    spec.pointer("/build/sdkVersion")
        .cloned()
        .unwrap_or(Value::Null)
}

/// The `spec_diff` result: every change with its `class`, the struct-field
/// rule where one applied, and the meta changes as `info`.
pub fn classify(before: &Value, after: &Value, sparse: bool) -> Value {
    let mut out = Vec::new();
    for c in diff_specs(before, after) {
        let mut class = if c.breaking { "breaking" } else { "compatible" };
        let mut item = Map::new();
        // A struct's added field (not a union case's: a case's payload is a
        // positional vec, which sparse decoding does not cover).
        let struct_field = c.kind == "field-added" && !c.path.contains(".cases.");
        if struct_field {
            let (rule, note) = if sparse && is_option(c.after.as_ref()) {
                class = "compatible";
                ("cap86-sparse-option", "The new build reads structs with CAP-86's sparse unpack and the field is an Option: values stored without it read it as None.")
            } else if sparse {
                ("cap86-sparse-required", "The new build reads structs sparsely, but the field is not an Option: a stored value without it does not decode.")
            } else {
                ("strict", "The new build reads structs strictly (no CAP-86 sparse unpack): a stored value without the field does not decode.")
            };
            item.insert("rule".into(), json!(rule));
            item.insert("storage_note".into(), json!(note));
        }
        item.insert("kind".into(), json!(c.kind));
        item.insert("path".into(), json!(c.path));
        item.insert("class".into(), json!(class));
        item.insert("reason".into(), json!(c.reason));
        if let Some(b) = c.before {
            item.insert("before".into(), b);
        }
        if let Some(a) = c.after {
            item.insert("after".into(), a);
        }
        out.push(Value::Object(item));
    }
    // Meta: what built the executable, and the interface it targets.
    for (kind, pointer, reason) in [
        (
            "sdk-version-changed",
            "/build/sdkVersion",
            "The SDK that built the contract changed.",
        ),
        (
            "rust-version-changed",
            "/build/rustVersion",
            "The Rust toolchain that built the contract changed.",
        ),
        (
            "interface-version-changed",
            "/env/protocolVersion",
            "The ledger protocol the contract targets changed.",
        ),
    ] {
        let (b, a) = (before.pointer(pointer), after.pointer(pointer));
        if b != a {
            out.push(json!({
                "kind": kind, "path": pointer.trim_start_matches('/').replace('/', "."),
                "class": "info", "reason": reason,
                "before": b.cloned().unwrap_or(Value::Null), "after": a.cloned().unwrap_or(Value::Null),
            }));
        }
    }
    let count = |class: &str| out.iter().filter(|c| c["class"] == class).count();
    json!({
        "compatible": count("breaking") == 0,
        "summary": { "breaking": count("breaking"), "compatible": count("compatible"), "info": count("info") },
        "sdk_versions": { "old": sdk_version(before), "new": sdk_version(after) },
        "sparse_decoding": sparse,
        "changes": out,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(functions: Value, types: Value, errors: Value) -> Value {
        json!({ "functions": functions, "types": types, "errors": errors, "events": [], "entriesXdr": [] })
    }

    #[test]
    fn docs_and_added_errors_are_compatible_and_meta_is_info() {
        let err = |name: &str, value: u32, doc: &str| json!({ "enumName": "E", "name": name, "value": value, "doc": doc });
        let mut before = spec(json!([]), json!([]), json!([err("A", 1, "old")]));
        let mut after = spec(
            json!([]),
            json!([]),
            json!([err("A", 1, "new"), err("B", 2, "")]),
        );
        before["build"] = json!({ "sdkVersion": "27.0.0" });
        after["build"] = json!({ "sdkVersion": "28.0.0" });
        let r = classify(&before, &after, true);
        let kinds: Vec<(&str, &str)> = r["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| (c["kind"].as_str().unwrap(), c["class"].as_str().unwrap()))
            .collect();
        assert_eq!(
            kinds,
            [
                ("documentation-changed", "compatible"),
                ("error-added", "compatible"),
                ("sdk-version-changed", "info")
            ]
        );
        assert_eq!(r["compatible"], true);
        assert_eq!(
            r["sdk_versions"],
            json!({ "old": "27.0.0", "new": "28.0.0" })
        );
    }

    #[test]
    fn an_added_struct_field_follows_the_storage_rule() {
        let field = |name: &str, ty: Value| json!({ "name": name, "doc": "", "type": ty });
        let profile = |fields: Vec<Value>| json!([{ "kind": "struct", "name": "Profile", "doc": "", "fields": fields }]);
        let before = spec(
            json!([]),
            profile(vec![field("id", json!("u32"))]),
            json!([]),
        );
        let optional = spec(
            json!([]),
            profile(vec![
                field("id", json!("u32")),
                field("bio", json!({ "type": "option", "value": "string" })),
            ]),
            json!([]),
        );
        let required = spec(
            json!([]),
            profile(vec![field("id", json!("u32")), field("age", json!("u32"))]),
            json!([]),
        );
        let rule = |after: &Value, sparse: bool| {
            let r = classify(&before, after, sparse);
            (
                r["changes"][0]["class"].clone(),
                r["changes"][0]["rule"].clone(),
            )
        };
        assert_eq!(
            rule(&optional, true),
            (json!("compatible"), json!("cap86-sparse-option"))
        );
        assert_eq!(rule(&optional, false), (json!("breaking"), json!("strict")));
        assert_eq!(
            rule(&required, true),
            (json!("breaking"), json!("cap86-sparse-required"))
        );
    }
}
