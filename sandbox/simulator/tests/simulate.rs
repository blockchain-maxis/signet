//! `simulate` (#534) and the lazy fork (#531) through the real binary.
//!
//! [`Sim`] plays Go: it writes requests, answers every `ledger_fetch` from
//! recorded testnet entries (`tests/fixtures/`), and keeps the keys it was
//! asked for, so a test can assert what the simulator fetched and when.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

const TESTNET: &str = "Test SDF Network ; September 2015";
const REGISTRY: &str = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN";
const WALLET: &str = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ADMIN: &str = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
/// The ledger the registry recordings were captured at.
const FORK_LEDGER: u64 = 4_887_004;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

/// Every recorded `getLedgerEntries` entry, by key, in the RPC form Go
/// forwards: `data_xdr` (LedgerEntryData), `last_modified_ledger_seq`,
/// `ext_xdr` and `live_until_ledger`.
fn recorded_entries() -> HashMap<String, Value> {
    let mut out = HashMap::new();
    for name in [
        "network-config-entries.json",
        "registry-instance-entry.json",
        "registry-code-entry.json",
    ] {
        for e in fixture(name)["payload"]["entries"].as_array().unwrap() {
            out.insert(
                e["key"].as_str().unwrap().to_string(),
                json!({
                    "key_xdr": e["key"],
                    "data_xdr": e["xdr"],
                    "last_modified_ledger_seq": e["lastModifiedLedgerSeq"],
                    "ext_xdr": e.get("extXdr").cloned().unwrap_or(Value::Null),
                    "live_until_ledger": e.get("liveUntilLedgerSeq").cloned().unwrap_or(Value::Null),
                }),
            );
        }
    }
    out
}

fn network_config_entries() -> Vec<Value> {
    let all = recorded_entries();
    fixture("network-config-entries.json")["payload"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let mut entry = all[e["key"].as_str().unwrap()].clone();
            entry.as_object_mut().unwrap().remove("live_until_ledger");
            entry
        })
        .collect()
}

/// How the fake Go answers a fetch.
enum Answer {
    /// From the recordings; anything not recorded is absent.
    Recorded,
    /// An `error` with this `detail.kind`.
    Refuse(&'static str),
}

struct Sim {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    entries: HashMap<String, Value>,
    answer: Answer,
    next: u64,
    /// Every `keys_xdr` the simulator asked for, in order.
    fetched: Vec<String>,
}

impl Sim {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn signet-simulator");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut sim = Self {
            child,
            stdin,
            stdout,
            entries: recorded_entries(),
            answer: Answer::Recorded,
            next: 0,
            fetched: Vec::new(),
        };
        let ack = sim.send(json!({ "id": "hello", "type": "hello", "client_protocol_version": 1 }));
        assert_eq!(ack["type"], "hello_ack");
        sim
    }

    fn write(&mut self, message: &Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.flush().unwrap();
    }

    /// Sends one request (the envelope's version and id are filled in) and
    /// answers fetches until its reply arrives.
    fn send(&mut self, mut request: Value) -> Value {
        request["version"] = json!(1);
        if request.get("id").is_none() {
            self.next += 1;
            request["id"] = json!(format!("req-{}", self.next));
        }
        let id = request["id"].clone();
        self.write(&request);
        loop {
            let mut line = String::new();
            assert!(
                self.stdout.read_line(&mut line).unwrap() > 0,
                "the simulator exited"
            );
            let reply: Value = serde_json::from_str(&line).unwrap();
            if reply["type"] == "ledger_fetch" {
                let keys: Vec<String> = reply["keys_xdr"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| k.as_str().unwrap().to_string())
                    .collect();
                self.fetched.extend(keys.iter().cloned());
                let answer = match self.answer {
                    Answer::Recorded => json!({
                        "version": 1, "id": reply["id"], "type": "ledger_entries",
                        "entries": keys.iter().filter_map(|k| self.entries.get(k).cloned()).collect::<Vec<_>>(),
                    }),
                    Answer::Refuse(kind) => json!({
                        "version": 1, "id": reply["id"], "type": "error", "code": "fetch_failed",
                        "message": "the RPC is down", "detail": { "kind": kind },
                    }),
                };
                self.write(&answer);
                continue;
            }
            assert_eq!(reply["id"], id, "{reply}");
            return reply;
        }
    }

    fn call(&mut self, contract_id: &str, function: &str, args: Value) -> Value {
        self.send(json!({ "type": "simulate", "contract_id": contract_id, "function": function, "args": args }))
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn registry_wasm() -> String {
    let path = format!(
        "{}/../../packages/spec/fixtures/identity-registry.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    BASE64.encode(std::fs::read(path).unwrap())
}

/// A hand-built ledger: testnet's network config and a freshly installed
/// registry. Anything else a call reads (the auth nonce recording mode looks
/// up) is fetched, and the fake Go knows nothing else, so it is absent.
fn fresh_registry() -> (Sim, String) {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "sequence": 100, "timestamp": 1_790_000_000u64,
        "entries": network_config_entries(),
    }));
    assert_eq!(open["type"], "result", "{open}");
    assert!(
        sim.fetched.is_empty(),
        "the config was passed in, not fetched"
    );
    let installed = sim.send(json!({ "type": "contract_install", "wasm_base64": registry_wasm() }));
    assert_eq!(
        installed["wasm_hash"], "936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe",
        "{installed}"
    );
    let id = installed["contract_id"].as_str().unwrap().to_string();
    (sim, id)
}

#[test]
fn count_is_zero_on_an_empty_instance() {
    let (mut sim, registry) = fresh_registry();
    let r = sim.call(&registry, "count", json!({}));
    assert_eq!(r["type"], "result", "{r}");
    assert_eq!(r["return_value"], 0);
    assert_eq!(
        r["return_value_xdr"],
        BASE64.encode([0, 0, 0, 3, 0, 0, 0, 0])
    );
    assert_eq!(
        r["ledger"],
        json!({ "sequence": 100, "timestamp": 1_790_000_000u64, "protocol": 28 })
    );
    assert_eq!(r["misses"], json!([]));
}

#[test]
fn a_session_claims_resolves_and_refuses_a_taken_handle() {
    let (mut sim, registry) = fresh_registry();
    let init = sim.call(&registry, "initialize", json!({ "admin": ADMIN }));
    assert_eq!(init["type"], "result", "{init}");

    let claim = sim.call(
        &registry,
        "claim",
        json!({ "handle": "alice", "wallet": WALLET }),
    );
    assert_eq!(claim["type"], "result", "{claim}");
    // Recording-mode auth: one entry, for the wallet that must sign.
    assert_eq!(claim["auth"].as_array().unwrap().len(), 1, "{claim}");
    assert!(
        claim["fee"]["resource_fee"].as_i64().unwrap() > 0,
        "{claim}"
    );
    assert!(!claim["modified_entries"].as_array().unwrap().is_empty());
    assert!(
        claim["resources"]["footprint"]["read_write"]
            .as_array()
            .unwrap()
            .len()
            >= 2
    );

    // The session layer kept the claim, so a second one is refused by the
    // contract, by name.
    let again = sim.call(
        &registry,
        "claim",
        json!({ "handle": "alice", "wallet": WALLET }),
    );
    assert_eq!(again["type"], "contract_error", "{again}");
    assert_eq!(again["kind"], "contract", "{again}");
    assert_eq!(again["code"], "Error(Contract, #3)");
    assert_eq!(again["decoded"]["error_name"], "HandleTaken");
    assert_eq!(again["decoded"]["error_value"], 3);

    let resolved = sim.call(&registry, "resolve", json!({ "handle": "alice" }));
    assert_eq!(resolved["return_value"], WALLET, "{resolved}");
    let count = sim.call(&registry, "count", json!({}));
    assert_eq!(count["return_value"], 1, "{count}");
}

#[test]
fn a_dry_run_leaves_the_session_untouched_and_fees_are_stable() {
    let (mut sim, registry) = fresh_registry();
    sim.call(&registry, "initialize", json!({ "admin": ADMIN }));
    let dry = sim.send(json!({
        "type": "simulate", "contract_id": registry, "function": "claim",
        "args": { "handle": "bob", "wallet": WALLET }, "dry_run": true,
    }));
    assert_eq!(dry["type"], "result", "{dry}");
    let again = sim.send(json!({
        "type": "simulate", "contract_id": registry, "function": "claim",
        "args": { "handle": "bob", "wallet": WALLET }, "dry_run": true,
    }));
    // Same input, same state: same fee and resources, to the stroop. Only
    // the auth nonce in the footprint differs, as it does on the network.
    assert_eq!(dry["fee"], again["fee"]);
    for field in ["instructions", "disk_read_bytes", "write_bytes"] {
        assert_eq!(
            dry["resources"][field], again["resources"][field],
            "{field}"
        );
    }
    assert_eq!(dry["cost"], again["cost"]);
    assert!(dry["fee"]["resource_fee"].as_i64().unwrap() > 0);
    let resolved = sim.call(&registry, "resolve", json!({ "handle": "bob" }));
    assert_eq!(
        resolved["return_value"],
        Value::Null,
        "a dry run must not write: {resolved}"
    );
}

#[test]
fn a_wrong_argument_names_its_path() {
    let (mut sim, registry) = fresh_registry();
    let r = sim.call(
        &registry,
        "claim",
        json!({ "handle": "alice", "wallet": 5 }),
    );
    assert_eq!(r["code"], "bad_request", "{r}");
    assert_eq!(r["detail"]["path"], "args.wallet");
    assert_eq!(
        r["message"],
        "wallet: expected Address (G… or C…), got number"
    );
}

/// A fork of the deployed registry at the recorded ledger: nothing local,
/// everything fetched.
fn forked() -> Sim {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "sequence": FORK_LEDGER,
    }));
    assert_eq!(open["type"], "result", "{open}");
    sim
}

#[test]
fn the_first_call_fetches_and_an_identical_second_call_fetches_nothing() {
    let mut sim = forked();
    // Opening the fork fetched the network config (#535).
    let at_open = sim.fetched.len();
    assert_eq!(at_open, 10, "{:?}", sim.fetched);

    let first = sim.call(REGISTRY, "count", json!({}));
    assert_eq!(first["type"], "result", "{first}");
    let instance_key =
        fixture("registry-instance-entry.json")["request"]["params"]["keys"][0].clone();
    let code_key = fixture("registry-code-entry.json")["request"]["params"]["keys"][0].clone();
    assert_eq!(
        sim.fetched[at_open..],
        [
            instance_key.as_str().unwrap().to_string(),
            code_key.as_str().unwrap().to_string()
        ],
        "the first call fetches the instance, then its code"
    );
    assert_eq!(first["misses"], json!([instance_key, code_key]));

    let before = sim.fetched.len();
    let second = sim.call(REGISTRY, "count", json!({}));
    assert_eq!(second["return_value"], first["return_value"]);
    assert_eq!(sim.fetched.len(), before, "the second call fetched again");
    assert_eq!(second["misses"], json!([]));

    // A storage key the network lacks is fetched once, then remembered as
    // absent.
    let nobody = sim.call(
        REGISTRY,
        "resolve",
        json!({ "handle": "no-such-handle-xyz" }),
    );
    assert_eq!(nobody["return_value"], Value::Null, "{nobody}");
    assert_eq!(sim.fetched.len(), before + 1, "{:?}", sim.fetched);
    sim.call(
        REGISTRY,
        "resolve",
        json!({ "handle": "no-such-handle-xyz" }),
    );
    assert_eq!(
        sim.fetched.len(),
        before + 1,
        "an absent key was fetched twice"
    );
}

#[test]
fn deny_mode_names_the_key_it_would_have_fetched() {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "sequence": FORK_LEDGER, "fetch": "deny",
        "entries": network_config_entries(),
    }));
    assert_eq!(open["type"], "result", "{open}");
    let r = sim.call(REGISTRY, "count", json!({}));
    assert_eq!(r["code"], "fetch_failed", "{r}");
    assert_eq!(r["detail"]["kind"], "denied");
    assert!(
        r["detail"]["key"].as_str().unwrap().contains("instance"),
        "{r}"
    );
    assert!(sim.fetched.is_empty());
}

#[test]
fn go_failing_a_fetch_fails_the_call_with_its_reason() {
    let mut sim = forked();
    sim.answer = Answer::Refuse("rpc_unavailable");
    let r = sim.call(REGISTRY, "count", json!({}));
    assert_eq!(r["code"], "fetch_failed", "{r}");
    assert_eq!(r["detail"]["kind"], "rpc_unavailable");
    assert_eq!(r["message"], "the RPC is down");
    // The session is still usable once Go can answer.
    sim.answer = Answer::Recorded;
    assert_eq!(sim.call(REGISTRY, "count", json!({}))["type"], "result");
}

#[test]
fn status_reports_the_open_ledger() {
    let (mut sim, _) = fresh_registry();
    let s = sim.send(json!({ "type": "status" }));
    assert_eq!(s["ledger_open"], true, "{s}");
    assert_eq!(s["ledger_sequence"], 100);
    assert_eq!(s["contracts"], 1);
    assert_eq!(s["entries"], 12);
    // The effective config is testnet's, as loaded at open (#535).
    assert!(
        s["network_config"]["min_persistent_ttl"].as_u64().unwrap() > 0,
        "{s}"
    );
    assert!(
        s["network_config"]["fee_per_write_1kb"].as_i64().unwrap() > 0,
        "{s}"
    );
    assert_eq!(s["base_reserve"], 5_000_000);
}

#[test]
fn a_fork_fetches_its_network_config_when_it_opens() {
    let mut sim = Sim::start();
    let open = sim.send(
        json!({ "type": "ledger_open", "network_passphrase": TESTNET, "sequence": FORK_LEDGER }),
    );
    assert_eq!(open["type"], "result", "{open}");
    assert_eq!(sim.fetched.len(), 10, "{:?}", sim.fetched);
    assert!(
        open["network_config"]["tx_max_instructions"]
            .as_i64()
            .unwrap()
            > 0,
        "{open}"
    );
}

#[test]
fn a_missing_config_setting_fails_the_open_and_names_it() {
    let mut sim = Sim::start();
    let mut entries = network_config_entries();
    // ContractLedgerCostExtV0's key is the third of the ten.
    let dropped = entries.remove(2);
    assert_eq!(dropped["key_xdr"], "AAAACAAAAA8=");
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "sequence": 100, "fetch": "deny", "entries": entries,
    }));
    assert_eq!(open["code"], "fetch_failed", "{open}");
    assert_eq!(open["detail"]["kind"], "missing_config");
    assert_eq!(
        open["detail"]["missing"],
        json!(["ContractLedgerCostExtV0"])
    );
    assert!(open["message"]
        .as_str()
        .unwrap()
        .contains("ContractLedgerCostExtV0"));
    // The ledger did not stay open.
    assert_eq!(sim.send(json!({ "type": "status" }))["ledger_open"], false);

    // On a fork, a setting the network lacks is just as fatal.
    sim.entries.remove("AAAACAAAAA8=");
    let fork = sim.send(
        json!({ "type": "ledger_open", "network_passphrase": TESTNET, "sequence": FORK_LEDGER }),
    );
    assert_eq!(
        fork["detail"]["missing"],
        json!(["ContractLedgerCostExtV0"]),
        "{fork}"
    );
}
