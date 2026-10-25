//! `snapshot_read` and `entries_describe` (#554) through the real binary.
//!
//! The fixture is a `LedgerSnapshot` of the testnet registry at ledger
//! 4887004, written from the recorded `getLedgerEntries` answers
//! (`cli/internal/rpc/testdata/registry/`): reading it must give back exactly
//! the entries RPC gave.
#![cfg(feature = "lane-p28")]

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

fn testdata(name: &str) -> String {
    let path = format!(
        "{}/../../cli/internal/rpc/testdata/registry/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

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
fn a_snapshot_reads_back_as_the_entries_rpc_gave() {
    let replies = exchange(&[
        json!({ "version": 1, "id": "s", "type": "snapshot_read", "snapshot_json": testdata("snapshot.json") }),
        json!({ "version": 1, "id": "bad", "type": "snapshot_read", "snapshot_json": "{\"not\": \"a snapshot\"}" }),
    ]);
    let read = &replies[0];
    assert_eq!(read["type"], "result", "{read}");
    assert_eq!(read["sequence_number"], 4887004);
    assert_eq!(read["timestamp"], 1790458607u64);
    assert_eq!(read["protocol_version"], 28);
    assert_eq!(read["min_persistent_entry_ttl"], 120960);
    assert_eq!(
        read["network_id"], "cee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472",
        "sha256 of the testnet passphrase"
    );

    let recorded: Value = serde_json::from_str(&testdata("getLedgerEntries.json")).unwrap();
    let recorded = recorded["entries"].as_array().unwrap();
    let entries = read["entries"].as_array().unwrap();
    assert_eq!(entries.len(), recorded.len());
    for (got, want) in entries.iter().zip(recorded) {
        assert_eq!(got["key_xdr"], want["key"]);
        assert_eq!(got["data_xdr"], want["xdr"]);
        assert_eq!(got["ext_xdr"], want["extXdr"]);
        assert_eq!(
            got["last_modified_ledger_seq"],
            want["lastModifiedLedgerSeq"]
        );
        assert_eq!(
            got["live_until_ledger"],
            want.get("liveUntilLedgerSeq")
                .cloned()
                .unwrap_or(Value::Null)
        );
    }

    assert_eq!(replies[1]["code"], "bad_request");
    assert_eq!(replies[1]["detail"]["path"], "snapshot_json");
}

#[test]
fn entries_are_described_in_plain_terms() {
    let replies = exchange(&[json!({
        "version": 1, "id": "s", "type": "snapshot_read", "snapshot_json": testdata("snapshot.json"),
    })]);
    let entries = replies[0]["entries"].clone();
    let described = exchange(&[json!({
        "version": 1, "id": "d", "type": "entries_describe", "entries": entries,
    })]);
    let d = described[0]["entries"].as_array().unwrap();
    assert_eq!(d[0]["kind"], "instance", "{}", described[0]);
    assert_eq!(
        d[0]["contract"],
        "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"
    );
    assert_eq!(
        d[0]["storage"].as_array().unwrap().len(),
        2,
        "Admin and Count"
    );
    assert_eq!(d[0]["storage"][1]["value"], 2);
    assert_eq!(d[1]["kind"], "contract_code");
    assert_eq!(
        d[1]["hash"],
        "936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe"
    );
}
