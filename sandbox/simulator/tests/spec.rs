//! The spec verbs (#545) through the real binary: `spec_extract` returns the
//! SpecJson document, and `spec_encode_args` reports a wrong argument with
//! its path.

use std::io::Write;
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

const HELLO: &str = r#"{"version":1,"id":"hello","type":"hello","client_protocol_version":1}"#;

fn fixture(name: &str) -> String {
    let path = format!(
        "{}/../../packages/spec/fixtures/{name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    BASE64.encode(std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
}

/// Sends `requests` after the handshake and returns the replies to them.
fn exchange(requests: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn signet-simulator");
    let mut input = format!("{HELLO}\n");
    for r in requests {
        input.push_str(&r.to_string());
        input.push('\n');
    }
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .skip(1)
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn spec_extract_returns_the_spec_document() {
    let replies = exchange(&[json!({
        "version": 1, "id": "s1", "type": "spec_extract",
        "source": { "wasm_base64": fixture("identity-registry") },
    })]);
    let r = &replies[0];
    assert_eq!(r["type"], "result", "{r}");
    assert_eq!(
        r["wasm_hash"],
        "936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe"
    );
    assert_eq!(r["spec"]["wasmHash"], r["wasm_hash"]);
    assert_eq!(r["spec"]["entriesXdr"], r["spec_entries_xdr"]);
    let claim = r["spec"]["functions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "claim")
        .expect("claim");
    assert_eq!(claim["inputs"][1]["type"], "address");
    assert!(r["spec"]["errors"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["name"] == "HandleTaken" && e["value"] == 3));
}

#[test]
fn spec_encode_args_encodes_and_names_a_bad_argument() {
    let source = json!({ "wasm_base64": fixture("identity-registry") });
    let replies = exchange(&[
        json!({
            "version": 1, "id": "e1", "type": "spec_encode_args", "source": source,
            "function": "claim",
            "args": { "handle": "alice", "wallet": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
        }),
        json!({
            "version": 1, "id": "e2", "type": "spec_encode_args", "source": source,
            "function": "claim", "args": { "handle": "alice", "wallet": 5 },
        }),
        json!({
            "version": 1, "id": "e3", "type": "spec_encode_args", "source": source,
            "function": "nope", "args": [],
        }),
    ]);
    assert_eq!(replies[0]["type"], "result", "{}", replies[0]);
    assert_eq!(replies[0]["args_xdr"].as_array().unwrap().len(), 2);

    let e = &replies[1];
    assert_eq!(e["code"], "bad_request");
    assert_eq!(
        e["message"],
        "wallet: expected Address (G… or C…), got number"
    );
    assert_eq!(e["detail"]["kind"], "invalid_field");
    assert_eq!(e["detail"]["path"], "args.wallet");

    assert_eq!(replies[2]["detail"]["path"], "function");
}

#[test]
fn a_contract_source_needs_an_open_ledger() {
    let replies = exchange(&[json!({
        "version": 1, "id": "c1", "type": "spec_extract",
        "source": { "contract_id": "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN" },
    })]);
    assert_eq!(replies[0]["detail"]["kind"], "no_open_ledger");
}

#[test]
fn spec_decode_val_names_a_contract_error() {
    // ScVal::Error(ScError::Contract(3)): SCV_ERROR, SCE_CONTRACT, code 3.
    let error_3 = BASE64.encode([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3]);
    // ScVal::U32(7).
    let seven = BASE64.encode([0, 0, 0, 3, 0, 0, 0, 7]);
    let source = json!({ "wasm_base64": fixture("identity-registry") });
    let replies = exchange(&[
        json!({
            "version": 1, "id": "d1", "type": "spec_decode_val", "source": source,
            "function": "claim", "val_xdr": error_3,
        }),
        json!({
            "version": 1, "id": "d2", "type": "spec_decode_val", "source": source,
            "function": "count", "val_xdr": seven,
        }),
        json!({
            "version": 1, "id": "d3", "type": "spec_decode_val", "source": source,
            "function": "count", "val_xdr": error_3,
        }),
    ]);
    assert_eq!(
        replies[0]["value"]["error"]["name"], "HandleTaken",
        "{}",
        replies[0]
    );
    assert_eq!(replies[0]["value"]["error"]["code"], 3);
    assert_eq!(replies[1]["value"], 7);
    assert_eq!(replies[2]["code"], "bad_request");
    assert_eq!(replies[2]["detail"]["path"], "val_xdr");
}

/// A #529 sandbox fixture, base64.
fn sandbox_fixture(name: &str) -> String {
    let path = format!(
        "{}/../fixtures/wasm/{name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    BASE64.encode(std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}")))
}

/// `spec_diff` (#570) of two executables, by value.
fn spec_diff(old: String, new: String) -> Value {
    let r = exchange(&[json!({
        "version": 1, "id": "d", "type": "spec_diff",
        "old": { "wasm_base64": old }, "new": { "wasm_base64": new },
    })])
    .remove(0);
    assert_eq!(r["type"], "result", "{r}");
    r
}

fn changes(r: &Value) -> Vec<(String, String, String)> {
    r["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let s = |k: &str| c[k].as_str().unwrap_or_default().to_string();
            (s("kind"), s("path"), s("class"))
        })
        .collect()
}

#[test]
fn the_registry_against_itself_is_empty() {
    let r = spec_diff(fixture("identity-registry"), fixture("identity-registry"));
    assert_eq!(r["changes"], json!([]));
    assert_eq!(r["compatible"], true);
}

#[test]
fn fixture_pairs_are_classified() {
    let pair =
        |old: &str, new: &str| changes(&spec_diff(sandbox_fixture(old), sandbox_fixture(new)));
    let owned = |v: &[(&str, &str, &str)]| -> Vec<(String, String, String)> {
        v.iter()
            .map(|(a, b, c)| (a.to_string(), b.to_string(), c.to_string()))
            .collect()
    };
    // Breaking: a return type changed, an argument added, a function removed.
    assert!(pair("counter_v1", "counter_v2_return").contains(
        &owned(&[(
            "return-type-changed",
            "functions.increment.outputs",
            "breaking"
        )])[0]
    ));
    assert!(pair("counter_v1", "counter_v2_auth").contains(
        &owned(&[(
            "argument-added",
            "functions.increment.inputs.caller",
            "breaking"
        )])[0]
    ));
    assert!(pair("counter_v1", "counter_v2_write")
        .contains(&owned(&[("function-removed", "functions.upgrade", "breaking")])[0]));
    // Compatible: a function added.
    assert!(pair("counter_v2_write", "counter_v1")
        .contains(&owned(&[("function-added", "functions.upgrade", "compatible")])[0]));
    // A struct field: required is breaking for stored values; an Option
    // read through CAP-86's sparse unpack (soroban-sdk 28 builds) is not.
    let required = spec_diff(
        sandbox_fixture("profile_v1"),
        sandbox_fixture("profile_v2_field"),
    );
    assert_eq!(required["sparse_decoding"], true);
    let added = &required["changes"][0];
    assert_eq!(
        (
            added["kind"].as_str(),
            added["class"].as_str(),
            added["rule"].as_str()
        ),
        (
            Some("field-added"),
            Some("breaking"),
            Some("cap86-sparse-required")
        )
    );
    let optional = spec_diff(
        sandbox_fixture("profile_v1"),
        sandbox_fixture("profile_v2_optional"),
    );
    let added = &optional["changes"][0];
    assert_eq!(
        (
            added["kind"].as_str(),
            added["class"].as_str(),
            added["rule"].as_str()
        ),
        (
            Some("field-added"),
            Some("compatible"),
            Some("cap86-sparse-option")
        )
    );
    assert_eq!(optional["compatible"], true);
    assert_eq!(
        optional["sdk_versions"]["new"]
            .as_str()
            .map(|v| v.starts_with("28.")),
        Some(true)
    );
}

#[test]
fn a_changed_sdk_version_is_info() {
    // counter_v1 with its contractmetav0 `rssdkver` value edited in place.
    let path = format!(
        "{}/../fixtures/wasm/counter_v1.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    let wasm = std::fs::read(path).unwrap();
    let at = wasm
        .windows(8)
        .position(|w| w == b"rssdkver")
        .expect("rssdkver meta");
    let mut edited = wasm.clone();
    let digit = edited[at + 8..]
        .iter()
        .position(u8::is_ascii_digit)
        .unwrap()
        + at
        + 8;
    edited[digit] = if edited[digit] == b'9' {
        b'1'
    } else {
        edited[digit] + 1
    };
    let r = spec_diff(BASE64.encode(&wasm), BASE64.encode(&edited));
    assert_eq!(
        changes(&r),
        [(
            "sdk-version-changed".to_string(),
            "build.sdkVersion".to_string(),
            "info".to_string()
        )]
    );
    assert_eq!(
        r["summary"],
        json!({ "breaking": 0, "compatible": 0, "info": 1 })
    );
}
