//! The host reads specs as the shared TS reader does (#547).
//!
//! `sandbox/conformance/corpus.json` holds, for every fixture WASM, what the
//! shared reader in `packages/spec` says: its SpecJson, and for JSON argument
//! values (valid and invalid, generated from the spec) the `ScVal` XDR its
//! encoder produces or that it refuses. `generate.mts --check` keeps that in
//! step with the reader; this replays it through the host. `spec_extract`
//! must equal the reader's document, and `spec_encode_args` must give the
//! same bytes and the same verdict. Every deliberate difference is a line in
//! `sandbox/conformance/KNOWN_DIFFERENCES.md`.

use std::io::Write;
use std::process::{Command, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

/// SpecJson fields the host is allowed to fill differently, each justified
/// in KNOWN_DIFFERENCES.md.
const KNOWN_SPEC_DIFFERENCES: [&str; 1] = ["sdkVersion"];

fn conformance(path: &str) -> String {
    format!("{}/../conformance/{path}", env!("CARGO_MANIFEST_DIR"))
}

/// Sends `requests` after the handshake and returns the replies, in order.
fn exchange(requests: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn signet-simulator");
    let mut input =
        String::from(r#"{"version":1,"id":"hello","type":"hello","client_protocol_version":1}"#);
    input.push('\n');
    for r in requests {
        input.push_str(&r.to_string());
        input.push('\n');
    }
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()).unwrap());
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap();
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .skip(1)
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

#[test]
fn the_host_reads_and_encodes_every_fixture_as_the_shared_reader_does() {
    let corpus: Value =
        serde_json::from_str(&std::fs::read_to_string(conformance("corpus.json")).unwrap())
            .unwrap();
    let fixtures = corpus["fixtures"].as_array().unwrap();
    assert!(fixtures.len() >= 15, "the corpus covers the fixtures");

    // One request per fixture's spec, then one per case, in that order.
    let mut requests = Vec::new();
    let mut expected = Vec::new();
    for fixture in fixtures {
        let path = format!(
            "{}/../../{}",
            env!("CARGO_MANIFEST_DIR"),
            fixture["fixture"].as_str().unwrap()
        );
        let source = json!({ "wasm_base64": BASE64.encode(std::fs::read(&path).unwrap()) });
        requests.push(json!({
            "version": 1, "id": format!("spec-{}", requests.len()), "type": "spec_extract",
            "source": source,
        }));
        expected.push((fixture, None));
        for case in fixture["cases"].as_array().unwrap() {
            requests.push(json!({
                "version": 1, "id": format!("case-{}", requests.len()), "type": "spec_encode_args",
                "source": source, "function": case["function"], "args": case["args"],
            }));
            expected.push((fixture, Some(case)));
        }
    }
    let replies = exchange(&requests);
    assert_eq!(replies.len(), requests.len());

    let mut mismatches = Vec::new();
    let (mut specs, mut cases) = (0, 0);
    for ((fixture, case), reply) in expected.iter().zip(&replies) {
        let name = fixture["name"].as_str().unwrap();
        match case {
            None => {
                specs += 1;
                let mut host = reply["spec"].clone();
                let mut reader = fixture["specJson"].clone();
                for field in KNOWN_SPEC_DIFFERENCES {
                    host.as_object_mut().map(|o| o.remove(field));
                    reader.as_object_mut().map(|o| o.remove(field));
                }
                if host != reader {
                    mismatches.push(format!(
                        "{name}: spec_extract differs from the shared reader\n  reader: {reader}\n  host:   {host}"
                    ));
                }
            }
            Some(case) => {
                cases += 1;
                let want = &case["expected"];
                let host_ok = reply["type"] == "result";
                let reader_ok = want["ok"] == true;
                let label = format!(
                    "{name} / {}: args {}",
                    case["name"].as_str().unwrap(),
                    case["args"]
                );
                if host_ok != reader_ok {
                    mismatches.push(format!(
                        "{label}\n  reader: {}\n  host:   {}",
                        if reader_ok {
                            format!("encodes {}", want["argsXdr"])
                        } else {
                            format!("refuses: {}", want["reason"])
                        },
                        if host_ok {
                            format!("encodes {}", reply["args_xdr"])
                        } else {
                            format!("refuses: {}", reply["message"])
                        },
                    ));
                } else if host_ok && reply["args_xdr"] != want["argsXdr"] {
                    mismatches.push(format!(
                        "{label}\n  reader: {}\n  host:   {}",
                        want["argsXdr"], reply["args_xdr"]
                    ));
                }
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {specs} specs and {cases} cases disagree with the shared reader:\n\n{}",
        mismatches.len(),
        mismatches.join("\n\n")
    );
}

#[test]
fn every_known_difference_is_justified() {
    let known = std::fs::read_to_string(conformance("KNOWN_DIFFERENCES.md")).unwrap();
    for field in KNOWN_SPEC_DIFFERENCES {
        assert!(
            known.contains(&format!("`{field}`")),
            "{field} is skipped by the conformance test but not justified in KNOWN_DIFFERENCES.md"
        );
    }
}
