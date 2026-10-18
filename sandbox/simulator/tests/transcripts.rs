//! Replays the golden transcripts in `sandbox/protocol/transcripts/` through
//! the real binary and compares its output byte for byte.
//!
//! A transcript is NDJSON: lines the client sends (`hello`, `shutdown`, ...)
//! interleaved with the lines the simulator answers. `<commit>` and
//! `<version>` stand for the build identity baked into the binary.

use std::io::Write;
use std::process::{Command, Stdio};

const CLIENT_TYPES: [&str; 2] = ["hello", "shutdown"];

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
        let target = if CLIENT_TYPES.contains(&message_type(line).as_str()) {
            &mut sent
        } else {
            &mut expected
        };
        target.push_str(line);
        target.push('\n');
    }
    (sent, expected)
}

#[test]
fn hello_transcript_replays_byte_for_byte() {
    let (sent, expected) = load("hello.ndjson");
    let replay = run_simulator(&sent);
    assert_eq!(replay.stdout, expected);
    assert!(replay.status.success());
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
