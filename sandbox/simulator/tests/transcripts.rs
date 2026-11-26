//! Replays the golden transcripts in `sandbox/protocol/transcripts/` through
//! the real binary and compares its output byte for byte.
//!
//! A transcript is NDJSON: lines the client sends (`hello`, `shutdown`, ...)
//! interleaved with the lines the simulator answers. `<commit>` and
//! `<version>` stand for the build identity baked into the binary.

// The golden transcripts are the release build's: both lanes in hello_ack.
#![cfg(all(feature = "lane-p28", feature = "lane-p29"))]

use std::io::Write;
use std::process::{Command, Stdio};

const CLIENT_TYPES: [&str; 15] = [
    "hello",
    "shutdown",
    "xdr_keys",
    "tx_decode",
    "wasm_inspect",
    "ledger_open",
    "ledger_put",
    "ledger_get",
    "ledger_apply",
    "ledger_checkpoint",
    "ledger_rollback",
    "contract_install",
    "simulate",
    "ledger_entries",
    "frobnicate",
];

/// A documented skip list for transcripts that cannot be replayed through the
/// binary (for example, error conditions that cannot be produced on demand).
const SKIP_LIST: [&str; 1] = ["errors_panic.ndjson"];

/// Transcripts with a byte-for-byte replay test.
const REPLAY_TESTS: [&str; 9] = [
    "hello.ndjson",
    "version_mismatch.ndjson",
    "xdr_helpers.ndjson",
    "trace.ndjson",
    "ledger.ndjson",
    "simulate.ndjson",
    "ledger_fetch.ndjson",
    "contract_error.ndjson",
    "errors.ndjson",
];

struct Replay {
    stdout: String,
    status: std::process::ExitStatus,
}

fn run_simulator(stdin: &str) -> Replay {
    let mut child = Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn signet-simulator");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    Replay {
        stdout: String::from_utf8(out.stdout).unwrap(),
        status: out.status,
    }
}

fn message_type(line: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(line).expect("transcript line is JSON");
    v["type"]
        .as_str()
        .expect("transcript line has a type")
        .to_string()
}

fn is_client_message(line: &str) -> bool {
    let v: serde_json::Value = serde_json::from_str(line).expect("transcript line is JSON");
    let typ = v["type"].as_str().expect("transcript line has a type");
    if CLIENT_TYPES.contains(&typ) {
        return true;
    }
    if typ == "error" && v["id"].as_str().map_or(false, |id| id.starts_with("sim-")) {
        return true;
    }
    false
}

/// Splits a transcript into (client lines, expected simulator lines).
fn load(name: &str) -> (String, String) {
    let path = format!(
        "{}/../protocol/transcripts/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let text = text
        .replace("<commit>", env!("SIGNET_SIMULATOR_COMMIT"))
        .replace("<version>", env!("CARGO_PKG_VERSION"));
    let (mut sent, mut expected) = (String::new(), String::new());
    for line in text.lines().filter(|l| !l.is_empty()) {
        let target = if is_client_message(line) {
            &mut sent
        } else {
            &mut expected
        };
        target.push_str(line);
        target.push('\n');
    }
    (sent, expected)
}

fn assert_replays(name: &str) {
    let (sent, expected) = load(name);
    let replay = run_simulator(&sent);
    assert_eq!(replay.stdout, expected, "replay mismatch for {name}");
    assert!(
        replay.status.success(),
        "simulator exited with failure for {name}"
    );
}

#[test]
fn hello_transcript_replays_byte_for_byte() {
    assert_replays("hello.ndjson");
}

#[test]
fn version_mismatch_transcript_replays_byte_for_byte() {
    // A message with the wrong `version` is refused mid-session with
    // `unsupported_version`, and the session carries on.
    assert_replays("version_mismatch.ndjson");
}

#[test]
fn xdr_helpers_transcript_replays_byte_for_byte() {
    // xdr_keys, tx_decode and wasm_inspect (#532) on the testnet registry, a
    // recorded claim, and a fixture contract.
    assert_replays("xdr_helpers.ndjson");
}

#[test]
fn trace_transcript_replays_byte_for_byte() {
    // A traced caller -> callee simulate (#541) on fixture contracts.
    assert_replays("trace.ndjson");
}

#[test]
fn ledger_transcript_replays_byte_for_byte() {
    // ledger_open (with network config), ledger_put, ledger_get, ledger_checkpoint,
    // and ledger_rollback to a valid handle, cp-0, and cp-99 (#929); then a
    // ledger_apply that deletes a key and the ledger_get that reports it (#934).
    assert_replays("ledger.ndjson");
}

#[test]
fn simulate_transcript_replays_byte_for_byte() {
    assert_replays("simulate.ndjson");
}

#[test]
fn ledger_fetch_transcript_replays_byte_for_byte() {
    assert_replays("ledger_fetch.ndjson");
}

#[test]
fn contract_error_transcript_replays_byte_for_byte() {
    assert_replays("contract_error.ndjson");
}

#[test]
fn errors_transcript_replays_byte_for_byte() {
    assert_replays("errors.ndjson");
}

#[test]
fn every_transcript_is_replayed_or_skipped() {
    let dir = format!("{}/../protocol/transcripts", env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().into_string().unwrap();
        if name.ends_with(".ndjson") {
            files.push(name);
        }
    }
    files.sort();
    for file in &files {
        assert!(
            REPLAY_TESTS.contains(&file.as_str()) || SKIP_LIST.contains(&file.as_str()),
            "transcript {file} has no replay test and is not on SKIP_LIST",
        );
    }
}

#[test]
fn hello_then_eof_prints_one_hello_ack_and_exits_zero() {
    let replay = run_simulator(
        "{\"version\":1,\"id\":\"hello\",\"type\":\"hello\",\"client_protocol_version\":1}\n",
    );
    assert!(replay.status.success());
    let lines: Vec<&str> = replay.stdout.lines().collect();
    assert_eq!(lines.len(), 1, "{}", replay.stdout);
    assert_eq!(message_type(lines[0]), "hello_ack");
}
