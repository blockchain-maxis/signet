//! Golden tests for the XDR helper verbs (#532), against the real binary and
//! real testnet recordings (tests/fixtures/README.md).
//!
//! Every expectation here was produced independently of this crate: the keys
//! are the ones the committed RPC captures asked for (or that
//! `@stellar/stellar-sdk` builds), the claim is what the SDK decodes from the
//! same envelope and meta, and the WASM facts are what Node's own
//! `WebAssembly.Module` reports for the committed fixture contracts.

use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

const REGISTRY: &str = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN";
/// The account that sent the recorded claim, and the wallet it claimed for.
const CLAIMANT: &str = "GCWEY5SG6LEGTI6MJ7BTS5FF22DDBZN3E6BS4AFFB44BNOAE4A5V4PWE";
const HANDLE: &str = "e2e-mui5xd56-uu5m";
/// The registry instance's executable, read from registry-instance-entry.json.
const REGISTRY_WASM_HASH: &str = "936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe";

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&text).unwrap()
}

fn wasm_fixture(name: &str) -> String {
    let path = format!("{}/../fixtures/wasm/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Sends `hello`, then `request` (given an id and the protocol version), then
/// `shutdown`, and returns the reply to `request`.
fn ask(mut request: Value) -> Value {
    request["version"] = json!(1);
    request["id"] = json!("q1");
    let input = format!(
        "{}\n{}\n{}\n",
        json!({ "version": 1, "id": "h", "type": "hello", "client_protocol_version": 1 }),
        request,
        json!({ "version": 1, "id": "s", "type": "shutdown" }),
    );
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
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "simulator exited with {}", out.status);
    let replies: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 3, "{replies:#?}");
    assert_eq!(replies[1]["id"], "q1");
    replies[1].clone()
}

fn ok(reply: Value) -> Value {
    assert_eq!(reply["type"], "result", "{reply:#}");
    reply
}

// ─── xdr_keys ──────────────────────────────────────────────────────────────────

#[test]
fn the_registry_instance_key_matches_the_one_rpc_was_asked_for() {
    let captured = fixture("registry-instance-entry.json");
    let expected = captured["request"]["params"]["keys"][0].as_str().unwrap();

    let reply = ok(ask(json!({
        "type": "xdr_keys",
        "keys": [{ "kind": "contract_instance", "contract_id": REGISTRY }],
    })));

    assert_eq!(
        reply["keys"],
        json!([{ "kind": "contract_instance", "subject": REGISTRY, "key_xdr": expected }])
    );
}

#[test]
fn code_and_account_keys_match_the_sdk() {
    let reply = ok(ask(json!({
        "type": "xdr_keys",
        "keys": [
            { "kind": "contract_code", "wasm_hash": REGISTRY_WASM_HASH },
            { "kind": "account", "account_id": CLAIMANT },
        ],
    })));

    assert_eq!(
        reply["keys"],
        json!([
            {
                "kind": "contract_code",
                "subject": REGISTRY_WASM_HASH,
                // packages/fixtures/data/contract-wasm-entry.json's request key.
                "key_xdr": "AAAAB5NplsdLfTg8VuwXSFexWSfN0pR4xpCdozK03si2czX+",
            },
            {
                "kind": "account",
                "subject": CLAIMANT,
                "key_xdr": "AAAAAAAAAACsTHZG8shpo8xPwzl0pdaGMOW7J4MuAKUPOBa4BOA7Xg==",
            },
        ])
    );
}

#[test]
fn network_config_names_every_setting_the_lane_loads() {
    let reply = ok(ask(json!({
        "type": "xdr_keys",
        "keys": [
            { "kind": "network_config" },
            { "kind": "config_setting", "setting": "ContractMaxSizeBytes" },
        ],
    })));

    let keys = reply["keys"].as_array().unwrap();
    let subjects: Vec<&str> = keys
        .iter()
        .map(|key| key["subject"].as_str().unwrap())
        .collect();
    assert_eq!(
        subjects,
        [
            "ContractComputeV0",
            "ContractLedgerCostV0",
            "ContractLedgerCostExtV0",
            "ContractHistoricalDataV0",
            "ContractEventsV0",
            "ContractBandwidthV0",
            "StateArchival",
            "ContractCostParamsCpuInstructions",
            "ContractCostParamsMemoryBytes",
            "LiveSorobanStateSizeWindow",
            "ContractMaxSizeBytes",
        ]
    );
    assert!(keys.iter().all(|key| key["kind"] == "config_setting"));
    // ConfigSettingId 0, as the SDK encodes it.
    assert_eq!(keys[10]["key_xdr"], "AAAACAAAAAA=");
}

#[test]
fn a_bad_strkey_is_a_bad_request_naming_its_field() {
    let reply = ask(json!({
        "type": "xdr_keys",
        "keys": [{ "kind": "contract_instance", "contract_id": CLAIMANT }],
    }));
    assert_eq!(reply["code"], "bad_request");
    assert_eq!(reply["detail"]["path"], "keys[0].contract_id");
}

// ─── tx_decode ─────────────────────────────────────────────────────────────────

#[test]
fn a_testnet_claim_decodes_to_claim_handle_wallet() {
    let captured = fixture("claim-get-transaction.json");
    let payload = &captured["payload"];

    let reply = ok(ask(json!({
        "type": "tx_decode",
        "transaction_xdr": payload["envelopeXdr"],
        "result_meta_xdr": payload["resultMetaXdr"],
    })));
    let tx = &reply["transaction"];

    assert_eq!(tx["source_account"], CLAIMANT);
    assert_eq!(tx["fee_bump"], false);

    let call = &tx["host_function"];
    assert_eq!(call["kind"], "invoke_contract");
    assert_eq!(call["replayable"], true);
    assert_eq!(call["contract_id"], REGISTRY);
    assert_eq!(call["function"], "claim");
    let args = call["args"].as_array().unwrap();
    assert_eq!(args.len(), 2);
    assert_eq!(
        (&args[0]["type"], &args[0]["value"]),
        (&json!("string"), &json!(HANDLE))
    );
    assert_eq!(
        (&args[1]["type"], &args[1]["value"]),
        (&json!("address"), &json!(CLAIMANT))
    );
    assert!(args.iter().all(|arg| arg["xdr"].is_string()));

    let auth = tx["auth"].as_array().unwrap();
    assert_eq!(auth.len(), 1);
    assert_eq!(auth[0]["credentials"], "source_account");
    assert_eq!(
        auth[0]["root_function"],
        json!({ "kind": "contract_fn", "contract_id": REGISTRY, "function": "claim" })
    );

    // What happened on chain, for #636's fidelity check.
    let result = &tx["result"];
    assert_eq!(result["meta_version"], 4);
    assert_eq!(result["return_value"]["type"], "void");
    let events = result["events"].as_array().unwrap();
    assert_eq!(events.len(), 1, "{events:#?}");
    assert_eq!(events[0]["type"], "contract");
    assert_eq!(events[0]["contract_id"], REGISTRY);
    assert_eq!(
        events[0]["topics"],
        json!([
            { "type": "symbol", "value": "claimed" },
            { "type": "string", "value": HANDLE },
        ])
    );
    assert_eq!(
        events[0]["data"],
        json!({ "type": "address", "value": CLAIMANT })
    );
}

#[test]
fn the_meta_is_optional() {
    let captured = fixture("claim-get-transaction.json");
    let reply = ok(ask(json!({
        "type": "tx_decode",
        "transaction_xdr": captured["payload"]["envelopeXdr"],
    })));
    assert_eq!(reply["transaction"]["host_function"]["function"], "claim");
    assert!(reply["transaction"].get("result").is_none());
}

#[test]
fn a_deployment_is_not_replayable_and_says_why() {
    let captured = fixture("deploy-get-transaction.json");
    let payload = &captured["payload"];

    let reply = ok(ask(json!({
        "type": "tx_decode",
        "transaction_xdr": payload["envelopeXdr"],
        "result_meta_xdr": payload["resultMetaXdr"],
    })));
    let tx = &reply["transaction"];

    assert_eq!(
        tx["source_account"],
        "GC6IQQHUT4BXZYCJEM4AOKFD6ASWSXCEDXYPVA5NFKXSGOSRJX72KJMC"
    );
    assert_eq!(tx["host_function"]["kind"], "create_contract");
    assert_eq!(tx["host_function"]["replayable"], false);
    assert!(tx["host_function"]["reason"].is_string());
    assert_eq!(tx["auth"], json!([]));
    // The new contract's address.
    assert_eq!(tx["result"]["return_value"]["type"], "address");
}

#[test]
fn a_meta_that_does_not_decode_is_blamed_on_the_meta() {
    let captured = fixture("claim-get-transaction.json");
    let reply = ask(json!({
        "type": "tx_decode",
        "transaction_xdr": captured["payload"]["envelopeXdr"],
        "result_meta_xdr": "AAAA",
    }));
    assert_eq!(reply["code"], "bad_request");
    assert_eq!(reply["detail"]["path"], "result_meta_xdr");
}

// ─── wasm_inspect ──────────────────────────────────────────────────────────────

#[test]
fn a_fixture_contract_declares_its_interface_version_and_sections() {
    let reply = ok(ask(json!({
        "type": "wasm_inspect",
        "wasm_base64": wasm_fixture("callee.wasm"),
    })));
    assert_eq!(
        reply,
        json!({
            "version": 1,
            "id": "q1",
            "type": "result",
            "wasm_hash": "1eb71402eae8897b1be9f352c379b4e66a39df5482527a0d7b4c3ac6a34f19a4",
            "size_bytes": 517,
            "custom_sections": ["contractenvmetav0", "contractmetav0", "contractmetav0", "contractspecv0"],
            "interface_version": { "protocol": 28, "pre_release": 0 },
            "exports": ["add"],
            "imports": [],
        })
    );
}

#[test]
fn imported_host_functions_are_listed_in_order() {
    let reply = ok(ask(json!({
        "type": "wasm_inspect",
        "wasm_base64": wasm_fixture("caller.wasm"),
    })));
    assert_eq!(
        reply["wasm_hash"],
        "e17c8e740c6413d171a03e885fca80cdc4b9f69a0a2743f5cd5f09ed65eb5d9e"
    );
    assert_eq!(reply["exports"], json!(["call_add"]));
    assert_eq!(
        reply["imports"],
        json!([
            { "module": "b", "name": "j" },
            { "module": "v", "name": "g" },
            { "module": "d", "name": "_" },
        ])
    );
}

#[test]
fn bytes_that_are_not_wasm_are_a_bad_request() {
    let reply = ask(json!({ "type": "wasm_inspect", "wasm_base64": "bm90IHdhc20=" }));
    assert_eq!(reply["code"], "bad_request");
    assert_eq!(reply["detail"]["path"], "wasm_base64");
}
