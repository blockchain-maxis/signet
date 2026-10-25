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
    /// Every line the simulator wrote, as written.
    raw: Vec<String>,
}

impl Sim {
    fn start() -> Self {
        Self::start_with_env(&[])
    }

    fn start_with_env(env: &[(&str, &str)]) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
            .envs(env.iter().copied())
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
            raw: Vec::new(),
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
            self.raw.push(line.clone());
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
fn fresh_registry(lane: u32) -> (Sim, String) {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": 100, "timestamp": 1_790_000_000u64,
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

fn count_is_zero_on_an_empty_instance(lane: u32) {
    let (mut sim, registry) = fresh_registry(lane);
    let r = sim.call(&registry, "count", json!({}));
    assert_eq!(r["type"], "result", "{r}");
    assert_eq!(r["return_value"], 0);
    assert_eq!(
        r["return_value_xdr"],
        BASE64.encode([0, 0, 0, 3, 0, 0, 0, 0])
    );
    assert_eq!(
        r["ledger"],
        json!({ "sequence": 100, "timestamp": 1_790_000_000u64, "protocol": lane })
    );
    assert_eq!(r["misses"], json!([]));
}

fn a_session_claims_resolves_and_refuses_a_taken_handle(lane: u32) {
    let (mut sim, registry) = fresh_registry(lane);
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
    assert_eq!(claim["auth_entries"][0]["address"], WALLET, "{claim}");
    assert_eq!(
        claim["auth_entries"][0]["root_function"]["function"],
        "claim"
    );
    assert_eq!(claim["auth_entries"][0]["credentials"], "address");
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

fn a_dry_run_leaves_the_session_untouched_and_fees_are_stable(lane: u32) {
    let (mut sim, registry) = fresh_registry(lane);
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

fn a_wrong_argument_names_its_path(lane: u32) {
    let (mut sim, registry) = fresh_registry(lane);
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
fn forked(lane: u32) -> Sim {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": FORK_LEDGER,
    }));
    assert_eq!(open["type"], "result", "{open}");
    sim
}

fn the_first_call_fetches_and_an_identical_second_call_fetches_nothing(lane: u32) {
    let mut sim = forked(lane);
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

fn deny_mode_names_the_key_it_would_have_fetched(lane: u32) {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": FORK_LEDGER, "fetch": "deny",
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

fn go_failing_a_fetch_fails_the_call_with_its_reason(lane: u32) {
    let mut sim = forked(lane);
    sim.answer = Answer::Refuse("rpc_unavailable");
    let r = sim.call(REGISTRY, "count", json!({}));
    assert_eq!(r["code"], "fetch_failed", "{r}");
    assert_eq!(r["detail"]["kind"], "rpc_unavailable");
    assert_eq!(r["message"], "the RPC is down");
    // The session is still usable once Go can answer.
    sim.answer = Answer::Recorded;
    assert_eq!(sim.call(REGISTRY, "count", json!({}))["type"], "result");
}

fn status_reports_the_open_ledger(lane: u32) {
    let (mut sim, _) = fresh_registry(lane);
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

fn a_fork_fetches_its_network_config_when_it_opens(lane: u32) {
    let mut sim = Sim::start();
    let open = sim.send(
        json!({ "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": FORK_LEDGER }),
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

fn a_missing_config_setting_fails_the_open_and_names_it(lane: u32) {
    let mut sim = Sim::start();
    let mut entries = network_config_entries();
    // ContractLedgerCostExtV0's key is the third of the ten.
    let dropped = entries.remove(2);
    assert_eq!(dropped["key_xdr"], "AAAACAAAAA8=");
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": 100, "fetch": "deny", "entries": entries,
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
        json!({ "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": FORK_LEDGER }),
    );
    assert_eq!(
        fork["detail"]["missing"],
        json!(["ContractLedgerCostExtV0"]),
        "{fork}"
    );
}

fn contract_info_reads_and_fetches_a_contract_without_running_it(lane: u32) {
    let mut sim = forked(lane);
    let at_open = sim.fetched.len();
    let info = sim.send(json!({ "type": "contract_info", "contract_id": REGISTRY }));
    assert_eq!(info["type"], "result", "{info}");
    assert_eq!(info["executable"], "wasm");
    assert_eq!(
        info["wasm_hash"],
        "936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe"
    );
    assert!(info["storage_entries"].as_u64().unwrap() > 0, "{info}");
    assert!(info["wasm_size"].as_u64().unwrap() > 1000, "{info}");
    assert_eq!(info["misses"].as_array().unwrap().len(), 2);
    assert_eq!(sim.fetched.len(), at_open + 2);

    let account = sim.send(json!({ "type": "contract_info", "contract_id": WALLET }));
    assert_eq!(account["code"], "bad_request", "{account}");
    assert_eq!(account["detail"]["path"], "contract_id");
    let missing = sim.send(json!({
        "type": "contract_info",
        "contract_id": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    }));
    assert_eq!(missing["code"], "bad_request", "{missing}");
    assert!(
        missing["message"].as_str().unwrap().contains("no contract"),
        "{missing}"
    );
}

fn fixture_wasm(name: &str) -> Vec<u8> {
    let path = format!(
        "{}/../fixtures/wasm/{name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// A ledger with the network config and nothing else.
fn config_only(lane: u32) -> Sim {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": 100,
        "entries": network_config_entries(),
    }));
    assert_eq!(open["type"], "result", "{open}");
    sim
}

fn install(sim: &mut Sim, wasm: &[u8]) -> (String, String) {
    let r = sim.send(json!({ "type": "contract_install", "wasm_base64": BASE64.encode(wasm) }));
    assert_eq!(r["type"], "result", "{r}");
    (
        r["contract_id"].as_str().unwrap().to_string(),
        r["wasm_hash"].as_str().unwrap().to_string(),
    )
}

fn hot_swap_keeps_storage_and_runs_the_new_code(lane: u32) {
    let mut sim = config_only(lane);
    let (counter, v1) = install(&mut sim, &fixture_wasm("counter_v1"));
    let (_, v2) = install(&mut sim, &fixture_wasm("counter_v2_cost"));
    sim.call(&counter, "increment", json!({}));
    assert_eq!(
        sim.call(&counter, "increment", json!({}))["return_value"],
        2
    );

    let swap =
        sim.send(json!({ "type": "contract_swap", "contract_id": counter, "wasm_hash": v2 }));
    assert_eq!(swap["type"], "result", "{swap}");
    assert_eq!(swap["previous_wasm_hash"], v1);
    assert_eq!(swap["wasm_hash"], v2);
    assert_eq!(swap["mode"], "instance");
    assert_eq!(swap["layer"], "session");

    // The instance storage survived the swap, and the next call runs the new
    // code: its footprint reads v2's executable, not v1's.
    assert_eq!(sim.call(&counter, "get", json!({}))["return_value"], 2);
    let after = sim.call(&counter, "increment", json!({}));
    assert_eq!(after["return_value"], 3, "{after}");
    let read_code: Vec<String> = after["resources"]["footprint"]["read_only"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| {
            let bytes = BASE64.decode(k.as_str().unwrap()).unwrap();
            bytes[4..].iter().map(|b| format!("{b:02x}")).collect()
        })
        .collect();
    assert!(read_code.contains(&v2), "{read_code:?}");
    assert!(!read_code.contains(&v1), "{read_code:?}");
    let info = sim.send(json!({ "type": "contract_info", "contract_id": counter }));
    assert_eq!(info["wasm_hash"], v2, "{info}");
}

fn a_wasm_for_a_newer_protocol_is_refused(lane: u32) {
    let mut sim = config_only(lane);
    let mut wasm = fixture_wasm("counter_v1");
    // contractenvmetav0's payload is one ScEnvMetaEntry: kind (u32 0), then
    // the protocol. Point it one past the lane.
    let name = b"contractenvmetav0";
    let at = wasm.windows(name.len()).position(|w| w == name).unwrap() + name.len() + 4;
    wasm[at..at + 4].copy_from_slice(&(lane + 1).to_be_bytes());
    let r = sim.send(json!({ "type": "contract_install", "wasm_base64": BASE64.encode(&wasm) }));
    assert_eq!(r["code"], "bad_request", "{r}");
    assert_eq!(r["detail"]["contract_protocol"], lane + 1);
    assert_eq!(r["detail"]["lane_protocol"], lane);
    assert!(
        r["message"]
            .as_str()
            .unwrap()
            .contains(&format!("targets ledger protocol {}", lane + 1)),
        "{r}"
    );
}

/// CAP-85 entries, built with the lane's own XDR (stellar-xdr 28, which
/// both lanes share): an owner's ExecutableTag entry pointing at `hash`, and
/// an instance of `contract` running through it.
fn external_ref_entries(
    owner: [u8; 32],
    contract: [u8; 32],
    hash: [u8; 32],
) -> (String, Vec<Value>) {
    #[cfg(all(not(feature = "lane-p29"), feature = "lane-p28"))]
    use soroban_env_host_p28::xdr;
    #[cfg(feature = "lane-p29")]
    use soroban_env_host_p29::xdr;
    use xdr::WriteXdr;
    let owner = xdr::ScAddress::Contract(xdr::ContractId(xdr::Hash(owner)));
    let tag = xdr::ScString("v1".try_into().unwrap());
    let data = |contract: xdr::ScAddress, key: xdr::ScVal, val: xdr::ScVal| {
        let key_xdr = xdr::LedgerKey::ContractData(xdr::LedgerKeyContractData {
            contract: contract.clone(),
            key: key.clone(),
            durability: xdr::ContractDataDurability::Persistent,
        });
        let entry = xdr::LedgerEntry {
            last_modified_ledger_seq: 1,
            data: xdr::LedgerEntryData::ContractData(xdr::ContractDataEntry {
                ext: xdr::ExtensionPoint::V0,
                contract,
                key,
                durability: xdr::ContractDataDurability::Persistent,
                val,
            }),
            ext: xdr::LedgerEntryExt::V0,
        };
        json!({
            "key_xdr": BASE64.encode(key_xdr.to_xdr(xdr::Limits::none()).unwrap()),
            "entry_xdr": BASE64.encode(entry.to_xdr(xdr::Limits::none()).unwrap()),
            "live_until_ledger": 1_000_000,
        })
    };
    let reference = data(
        owner.clone(),
        xdr::ScVal::ExecutableTag(tag.clone()),
        xdr::ScVal::Bytes(xdr::ScBytes(hash.to_vec().try_into().unwrap())),
    );
    let address = xdr::ScAddress::Contract(xdr::ContractId(xdr::Hash(contract)));
    let instance = data(
        address.clone(),
        xdr::ScVal::LedgerKeyContractInstance,
        xdr::ScVal::ContractInstance(xdr::ScContractInstance {
            executable: xdr::ContractExecutable::ExternalRef(xdr::ContractExecutableExternalRef {
                executable_owner: owner,
                tag,
            }),
            storage: None,
        }),
    );
    (address.to_string(), vec![reference, instance])
}

fn hex_bytes(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn an_external_ref_swap_needs_an_explicit_mode(lane: u32) {
    let mut sim = config_only(lane);
    let (_, v1) = install(&mut sim, &fixture_wasm("counter_v1"));
    let (_, v2) = install(&mut sim, &fixture_wasm("counter_v2_cost"));
    let (shared_a, mut entries) = external_ref_entries([9; 32], [1; 32], hex_bytes(&v1));
    let (shared_b, more) = external_ref_entries([9; 32], [2; 32], hex_bytes(&v1));
    entries.push(more[1].clone());
    assert_eq!(
        sim.send(json!({ "type": "ledger_put", "entries": entries }))["written"],
        3
    );

    // It runs through the reference.
    assert_eq!(
        sim.call(&shared_a, "increment", json!({}))["return_value"],
        1
    );

    let r = sim.send(json!({ "type": "contract_swap", "contract_id": shared_a, "wasm_hash": v2 }));
    assert_eq!(r["code"], "bad_request", "{r}");
    assert_eq!(r["detail"]["path"], "mode");
    let message = r["message"].as_str().unwrap();
    assert!(
        message.contains("mode \"instance\"") && message.contains("mode \"ref\""),
        "{message}"
    );

    // Repointing one instance leaves the other on the reference.
    let one = sim.send(json!({ "type": "contract_swap", "contract_id": shared_a, "wasm_hash": v2, "mode": "instance" }));
    assert_eq!(one["previous_wasm_hash"], v1, "{one}");
    assert_eq!(
        sim.send(json!({ "type": "contract_info", "contract_id": shared_a }))["executable"],
        "wasm"
    );
    assert_eq!(
        sim.send(json!({ "type": "contract_info", "contract_id": shared_b }))["wasm_hash"],
        v1
    );

    // Retargeting the reference moves every contract still on it.
    let all = sim.send(
        json!({ "type": "contract_swap", "contract_id": shared_b, "wasm_hash": v2, "mode": "ref" }),
    );
    assert_eq!(all["mode"], "ref", "{all}");
    assert_eq!(all["previous_wasm_hash"], v1);
    let info = sim.send(json!({ "type": "contract_info", "contract_id": shared_b }));
    assert_eq!(info["executable"], "external_ref");
    assert_eq!(info["wasm_hash"], v2, "{info}");
}

fn a_session_layer_swap_rolls_back(lane: u32) {
    let mut sim = config_only(lane);
    let (counter, v1) = install(&mut sim, &fixture_wasm("counter_v1"));
    let (_, v2) = install(&mut sim, &fixture_wasm("counter_v2_cost"));
    let cp = sim.send(json!({ "type": "ledger_checkpoint" }))["checkpoint"].clone();
    let swap = sim.send(json!({ "type": "contract_swap", "contract_id": counter, "wasm_hash": v2, "layer": "session" }));
    assert_eq!(swap["layer"], "session", "{swap}");
    sim.send(json!({ "type": "ledger_rollback", "checkpoint": cp }));
    assert_eq!(
        sim.send(json!({ "type": "contract_info", "contract_id": counter }))["wasm_hash"],
        v1
    );
}

/// A ledger with config and the registry and dice fixtures, opened under
/// `session_id`.
fn seeded(lane: u32, session_id: &str) -> (Sim, String, String) {
    let mut sim = Sim::start();
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": 100,
        "timestamp": 1_790_000_000u64, "session_id": session_id, "entries": network_config_entries(),
    }));
    assert_eq!(open["type"], "result", "{open}");
    let registry = sim.send(json!({ "type": "contract_install", "wasm_base64": registry_wasm() }))
        ["contract_id"]
        .as_str()
        .unwrap()
        .to_string();
    let (dice, _) = install(&mut sim, &fixture_wasm("dice"));
    (sim, registry, dice)
}

fn the_seed_is_derived_and_drives_env_prng(lane: u32) {
    let roll = |session: &str| {
        let (mut sim, _, dice) = seeded(lane, session);
        let first = sim.call(&dice, "roll", json!({}));
        let second = sim.call(&dice, "roll", json!({}));
        (first, second)
    };
    let (a1, a2) = roll("session-a");
    let (b1, _) = roll("session-a");
    let (c1, _) = roll("session-b");
    assert_eq!(
        a1["return_value"], b1["return_value"],
        "same session, same value"
    );
    assert_ne!(
        a1["return_value"], c1["return_value"],
        "another session, another value"
    );
    assert_ne!(
        a1["return_value"], a2["return_value"],
        "the next call draws a new seed"
    );

    use sha2::{Digest, Sha256};
    let mut expected = Sha256::new();
    expected.update(b"session-a");
    expected.update(0u64.to_be_bytes());
    let hex: String = expected
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(a1["seed"], hex);
}

fn a_session_replays_byte_for_byte(lane: u32) {
    let session = |sim: &mut Sim, registry: &str, dice: &str| {
        sim.call(registry, "initialize", json!({ "admin": ADMIN }));
        for i in 0..8 {
            sim.call(
                registry,
                "claim",
                json!({ "handle": format!("h{i}"), "wallet": WALLET }),
            );
        }
        sim.call(
            registry,
            "claim",
            json!({ "handle": "h0", "wallet": WALLET }),
        );
        for i in 0..4 {
            sim.call(registry, "resolve", json!({ "handle": format!("h{i}") }));
        }
        sim.call(registry, "count", json!({}));
        for _ in 0..3 {
            sim.call(dice, "roll", json!({}));
        }
        sim.call(registry, "claim", json!({ "handle": "h9", "wallet": 5 }));
    };
    let run = || {
        let (mut sim, registry, dice) = seeded(lane, "replay");
        let before = sim.raw.len();
        session(&mut sim, &registry, &dice);
        sim.raw[before..].to_vec()
    };
    let (first, second) = (run(), run());
    assert_eq!(first.len(), second.len());
    assert!(first.len() >= 20, "{} replies", first.len());
    for (i, (a, b)) in first.iter().zip(&second).enumerate() {
        assert_eq!(a, b, "reply {i} differs between two fresh runs");
    }
}

fn guarded(lane: u32, env: &[(&str, &str)]) -> (Sim, String, String) {
    let mut sim = Sim::start_with_env(env);
    let open = sim.send(json!({
        "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": lane, "sequence": 100,
        "entries": network_config_entries(),
    }));
    assert_eq!(open["type"], "result", "{open}");
    let (looper, _) = install(&mut sim, &fixture_wasm("looper"));
    let (hog, _) = install(&mut sim, &fixture_wasm("hog"));
    (sim, looper, hog)
}

fn the_budget_stops_a_runaway_call_and_the_next_call_runs(lane: u32) {
    let (mut sim, looper, hog) = guarded(lane, &[]);
    let (dice, _) = install(&mut sim, &fixture_wasm("dice"));

    let spin = sim.call(&looper, "run", json!({}));
    assert_eq!(spin["type"], "contract_error", "{spin}");
    assert_eq!(spin["kind"], "host");
    assert!(
        spin["code"].as_str().unwrap().starts_with("Error(Budget"),
        "{spin}"
    );
    assert!(
        spin.get("budget").is_none(),
        "no override, nothing to report"
    );
    assert_eq!(sim.call(&dice, "roll", json!({}))["type"], "result");

    let grow = sim.call(&hog, "allocate", json!({ "count": 10_000 }));
    assert_eq!(grow["kind"], "host", "{grow}");
    assert!(
        grow["code"].as_str().unwrap().starts_with("Error(Budget"),
        "{grow}"
    );
    assert_eq!(sim.call(&dice, "roll", json!({}))["type"], "result");
}

fn a_budget_override_is_capped_and_reported(lane: u32) {
    let (mut sim, looper, _) = guarded(lane, &[]);
    let limit = sim.send(json!({ "type": "status" }))["network_config"]["tx_max_instructions"]
        .as_u64()
        .unwrap();

    let over = sim.send(json!({
        "type": "simulate", "contract_id": looper, "function": "run", "args": {},
        "budget": { "instructions": limit * 10 + 1 },
    }));
    assert_eq!(over["code"], "bad_request", "{over}");
    assert_eq!(over["detail"]["path"], "budget.instructions");

    // A smaller budget is an override too: it is reported, and enforced.
    let halved = sim.send(json!({
        "type": "simulate", "contract_id": looper, "function": "run", "args": {},
        "budget": { "instructions": limit / 2 },
    }));
    assert_eq!(halved["kind"], "host", "{halved}");
    assert_eq!(halved["budget"]["instructions"], limit / 2);
    let spent = halved["cost"]["cpu_insns"].as_u64().unwrap();
    assert!(spent <= limit / 2 + limit / 10, "{halved}");

    // Unlimited is the ceiling, for both limits, and is reported as such.
    // (A cheap call: running the looper to ten times the limit takes minutes
    // in a debug build.)
    let (dice, _) = install(&mut sim, &fixture_wasm("dice"));
    let unlimited = sim.send(json!({
        "type": "simulate", "contract_id": dice, "function": "roll", "args": {},
        "budget": { "unlimited": true },
    }));
    assert_eq!(
        unlimited["budget"]["instructions"],
        limit * 10,
        "{unlimited}"
    );
    let mem = sim.send(json!({ "type": "status" }))["network_config"]["tx_memory_limit"]
        .as_u64()
        .unwrap();
    assert_eq!(unlimited["budget"]["mem_bytes"], mem * 10, "{unlimited}");
}

fn the_memory_guard_stops_the_process_with_resource_limit(lane: u32) {
    let (mut sim, _, hog) = guarded(lane, &[("SIGNET_SIMULATOR_MEMORY_LIMIT", "134217728")]);
    let mem = sim.send(json!({ "type": "status" }))["network_config"]["tx_memory_limit"]
        .as_u64()
        .unwrap();
    // A lifted memory budget lets the host grow past the 128 MiB guard.
    sim.write(&json!({
        "version": 1, "id": "big", "type": "simulate", "contract_id": hog, "function": "allocate",
        "args": { "count": 10_000 }, "budget": { "mem_bytes": mem * 10, "instructions": 1_000_000_000u64 },
    }));
    let mut line = String::new();
    sim.stdout.read_line(&mut line).unwrap();
    let reply: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(reply["code"], "resource_limit", "{reply}");
    assert_eq!(reply["detail"]["kind"], "memory");
    assert_eq!(reply["id"], Value::Null);
    let status = sim.child.wait().unwrap();
    assert!(!status.success(), "the process should have stopped");

    // A fresh process, as Go respawns one, runs the next call.
    let (mut next, _, _) = guarded(lane, &[]);
    let (dice, _) = install(&mut next, &fixture_wasm("dice"));
    assert_eq!(next.call(&dice, "roll", json!({}))["type"], "result");
}

fn a_saved_session_is_restored_in_a_new_process(lane: u32) {
    let (mut first, registry) = fresh_registry(lane);
    first.call(&registry, "initialize", json!({ "admin": ADMIN }));
    let claim = first.call(
        &registry,
        "claim",
        json!({ "handle": "carol", "wallet": WALLET }),
    );
    // What Go keeps for a named session: every write, with its TTL.
    let mut saved = Vec::new();
    for call in [&claim] {
        for m in call["modified_entries"].as_array().unwrap() {
            assert!(m.get("live_until_ledger").is_some(), "{m}");
            saved.push(json!({
                "key_xdr": m["key_xdr"], "entry_xdr": m["after_xdr"], "live_until_ledger": m["live_until_ledger"],
            }));
        }
    }
    // initialize's writes too, from a replay of the same call.
    let (mut second, registry2) = fresh_registry(lane);
    assert_eq!(registry, registry2, "the same WASM installs at the same id");
    let init = second.call(&registry, "initialize", json!({ "admin": ADMIN }));
    assert_eq!(init["type"], "result");
    let applied = second.send(json!({ "type": "ledger_apply", "entries": saved }));
    assert_eq!(applied["applied"], saved.len(), "{applied}");
    assert_eq!(
        second.call(&registry, "resolve", json!({ "handle": "carol" }))["return_value"],
        WALLET
    );
}

fn auth_modes_record_strict_and_enforce(lane: u32) {
    let mut sim = config_only(lane);
    let (counter, _) = install(&mut sim, &fixture_wasm("counter_v2_auth"));
    let (relay, _) = install(&mut sim, &fixture_wasm("relay"));
    let bump = |sim: &mut Sim, extra: Value| {
        let mut req = json!({
            "type": "simulate", "contract_id": relay, "function": "bump",
            "args": { "target": counter, "user": WALLET }, "dry_run": true,
        });
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        sim.send(req)
    };

    // record: approved, and the wallet's nested auth is listed.
    let recorded = bump(&mut sim, json!({}));
    assert_eq!(recorded["type"], "result", "{recorded}");
    assert_eq!(recorded["auth_mode"], "record");
    let entries = recorded["auth_entries"].as_array().unwrap();
    assert!(
        entries
            .iter()
            .any(|e| e["address"] == WALLET && e["root_function"]["function"] == "increment"),
        "{recorded}"
    );

    // strict: auth below the root invocation is refused, as on the network.
    let strict = bump(&mut sim, json!({ "auth_mode": "strict" }));
    assert_eq!(strict["type"], "contract_error", "{strict}");
    assert_eq!(strict["kind"], "host");
    assert!(
        strict["code"].as_str().unwrap().starts_with("Error(Auth"),
        "{strict}"
    );
    assert_eq!(strict["auth_mode"], "strict");

    // enforce: entries are checked; recorded ones carry no signature.
    let enforced = bump(
        &mut sim,
        json!({ "auth_mode": "enforce", "auth_entries": recorded["auth"] }),
    );
    assert_eq!(enforced["type"], "contract_error", "{enforced}");
    assert_eq!(enforced["auth_mode"], "enforce");
    let missing = bump(&mut sim, json!({ "auth_mode": "enforce" }));
    assert_eq!(missing["detail"]["path"], "auth_entries", "{missing}");
}

fn at(sim: &mut Sim, contract_id: &str, function: &str, args: Value, ledger: Value) -> Value {
    sim.send(json!({
        "type": "simulate", "contract_id": contract_id, "function": function, "args": args,
        "ledger": ledger,
    }))
}

fn a_vesting_lock_opens_when_the_clock_is_moved(lane: u32) {
    let mut sim = config_only(lane);
    let (vesting, _) = install(&mut sim, &fixture_wasm("vesting"));
    let unlock = json!({ "unlock_time": 2_000_000_000u64 });

    let now = sim.call(&vesting, "is_unlocked", unlock.clone());
    assert_eq!(now["return_value"], false, "{now}");
    assert!(now["ledger"].get("overridden").is_none(), "{now}");

    let later = at(
        &mut sim,
        &vesting,
        "is_unlocked",
        unlock.clone(),
        json!({ "timestamp": 2_000_000_000u64 }),
    );
    assert_eq!(later["return_value"], true, "{later}");
    assert_eq!(later["ledger"]["timestamp"], 2_000_000_000u64);
    assert_eq!(
        later["ledger"]["sequence"], 100,
        "the sequence is left alone"
    );
    assert_eq!(later["ledger"]["overridden"], true);

    let claimed = at(
        &mut sim,
        &vesting,
        "claim",
        unlock.clone(),
        json!({ "timestamp": 2_000_000_000u64 }),
    );
    assert_eq!(claimed["return_value"], true, "{claimed}");
    let again = at(
        &mut sim,
        &vesting,
        "claim",
        unlock.clone(),
        json!({ "timestamp": 2_000_000_000u64 }),
    );
    assert_eq!(
        again["type"], "contract_error",
        "the claim was kept: {again}"
    );

    // The override was for those calls only: the session's clock is where
    // it was.
    let after = sim.call(&vesting, "is_unlocked", unlock);
    assert_eq!(after["return_value"], false, "{after}");

    let bad = at(
        &mut sim,
        &vesting,
        "is_unlocked",
        json!({ "unlock_time": 0 }),
        json!({ "sequence": 0 }),
    );
    assert_eq!(bad["type"], "error", "{bad}");
    assert!(
        bad["message"].as_str().unwrap().contains("ledger.sequence"),
        "{bad}"
    );
}

fn moving_past_a_ttl_archives_the_entry_and_the_call_restores_it(lane: u32) {
    // A forked contract carries the network's TTLs; an installed one never
    // lapses.
    let mut sim = forked(lane);
    let traced = sim.send(json!({
        "type": "simulate", "contract_id": REGISTRY, "function": "count", "args": {}, "trace": true,
    }));
    assert_eq!(traced["trace"]["seeded"], false, "all fetched: {traced}");
    let wasm_hash = traced["trace"]["frames"][0]["wasm_hash"].as_str().unwrap();
    assert_eq!(wasm_hash.len(), 64);
    let live = sim.call(REGISTRY, "count", json!({}));
    assert_eq!(live["type"], "result", "{live}");
    assert!(live.get("archived").is_none(), "{live}");

    // Far past every TTL the network gave it.
    let far = 3_000_000_000u32;
    let moved = sim.send(json!({
        "type": "simulate", "contract_id": REGISTRY, "function": "count", "args": {}, "trace": true,
        "ledger": { "timestamp": 1 },
    }));
    assert_eq!(
        moved["trace"]["seeded"], true,
        "a moved ledger is not the network's"
    );
    let lapsed = at(
        &mut sim,
        REGISTRY,
        "count",
        json!({}),
        json!({ "sequence": far }),
    );
    assert_eq!(lapsed["type"], "result", "{lapsed}");
    assert_eq!(
        lapsed["return_value"], live["return_value"],
        "a restored entry keeps its value"
    );
    let archived = lapsed["archived"]
        .as_array()
        .expect("archived entries are named");
    assert!(
        archived
            .iter()
            .any(|a| a["key"].as_str().unwrap().ends_with("instance")),
        "{lapsed}"
    );
    assert!(
        archived.iter().all(|a| a["outcome"] == "restored"),
        "{lapsed}"
    );
    assert!(archived
        .iter()
        .all(|a| a["live_until_ledger"].as_u64().unwrap() < far as u64));
    // Restoring is a write: each restored entry comes back with a fresh TTL.
    let modified = lapsed["modified_entries"].as_array().unwrap();
    for entry in archived {
        let restored = modified
            .iter()
            .find(|m| m["key_xdr"] == entry["key_xdr"])
            .unwrap_or_else(|| panic!("{} not restored: {lapsed}", entry["key"]));
        assert!(
            restored["live_until_ledger"].as_u64().unwrap() >= far as u64,
            "{restored}"
        );
    }
}

fn a_trace_shows_the_two_level_call_tree(lane: u32) {
    let mut sim = config_only(lane);
    let (callee, _) = install(&mut sim, &fixture_wasm("callee"));
    let (caller, _) = install(&mut sim, &fixture_wasm("caller"));
    let args = json!({ "callee": callee, "a": 2, "b": 3 });
    let call = |sim: &mut Sim, trace: Value| {
        sim.send(json!({
            "type": "simulate", "contract_id": caller, "function": "call_add", "args": args,
            "trace": trace,
        }))
    };

    let traced = call(&mut sim, json!(true));
    assert_eq!(traced["return_value"], 5, "{traced}");
    assert_eq!(
        traced["diagnostic_events"],
        json!([]),
        "a trace alone asks for no diagnostics"
    );
    let trace = &traced["trace"];
    assert_eq!(trace["version"], 1);
    assert_eq!(trace["ledger"], 100);
    assert_eq!(
        trace["seeded"], true,
        "installed contracts are not the network's"
    );
    assert_eq!(trace["truncated"], false);
    let frames = trace["frames"].as_array().unwrap();
    assert_eq!(frames.len(), 2, "{trace}");
    let u32_xdr = |n: u32| {
        let mut v = vec![0, 0, 0, 3];
        v.extend(n.to_be_bytes());
        BASE64.encode(v)
    };

    let (root, nested) = (&frames[0], &frames[1]);
    assert_eq!(root["contract"], caller);
    assert_eq!(root["function"], "call_add");
    assert_eq!(
        (root["depth"].clone(), root["parent"].clone()),
        (json!(0), Value::Null)
    );
    assert_eq!(root["args_xdr"].as_array().unwrap().len(), 3);
    assert_eq!(root["args_xdr"][1], u32_xdr(2));
    assert_eq!(root["result_xdr"], u32_xdr(5));

    assert_eq!(nested["contract"], callee);
    assert_eq!(nested["function"], "add");
    assert_eq!(
        (nested["depth"].clone(), nested["parent"].clone()),
        (json!(1), json!(0))
    );
    assert_eq!(nested["args_xdr"], json!([u32_xdr(2), u32_xdr(3)]));
    assert_eq!(
        nested["args_exact"], true,
        "the callee's spec settles the arity"
    );
    assert_eq!(nested["result_xdr"], u32_xdr(5));
    assert_eq!(nested["error"], Value::Null);

    let storage = trace["storage"].as_array().unwrap();
    assert_eq!(storage[0]["contract"], caller, "{trace}");
    assert!(storage.iter().any(|s| s["contract"] == callee), "{trace}");

    // A cap keeps the first frames and says so.
    let capped = call(&mut sim, json!({ "max_frames": 1 }));
    assert_eq!(capped["trace"]["frames"].as_array().unwrap().len(), 1);
    assert_eq!(capped["trace"]["truncated"], true);
    assert_eq!(capped["trace"]["frame_count"], 2);

    let plain = call(&mut sim, json!(false));
    assert!(plain.get("trace").is_none(), "{plain}");
    assert_eq!(call(&mut sim, json!({ "max_frames": 0 }))["type"], "error");
}

fn a_call_reports_the_contracts_it_reached_and_can_be_kept_to_its_own(lane: u32) {
    let mut sim = config_only(lane);
    let (callee, _) = install(&mut sim, &fixture_wasm("callee"));
    let (caller, _) = install(&mut sim, &fixture_wasm("caller"));
    let args = json!({ "callee": callee, "a": 2, "b": 3 });

    let reached = sim.call(&caller, "call_add", args.clone());
    assert_eq!(reached["return_value"], 5, "{reached}");
    assert_eq!(
        reached["contracts"],
        json!([{ "contract_id": callee, "executable": "wasm" }]),
        "the callee, not the caller itself"
    );
    let alone = sim.call(&callee, "add", json!({ "a": 1, "b": 1 }));
    assert_eq!(alone["contracts"], json!([]));

    let kept = sim.send(json!({
        "type": "simulate", "contract_id": caller, "function": "call_add", "args": args,
        "related": false,
    }));
    assert_eq!(kept["code"], "fetch_failed", "{kept}");
    assert_eq!(kept["detail"]["kind"], "related");
    assert_eq!(kept["detail"]["contract_id"], callee);
    assert!(
        kept["message"].as_str().unwrap().contains(callee.as_str()),
        "{kept}"
    );
    // Kept to itself, a contract that calls nothing still runs.
    let own = sim.send(json!({
        "type": "simulate", "contract_id": callee, "function": "add", "args": { "a": 1, "b": 1 },
        "related": false,
    }));
    assert_eq!(own["return_value"], 2, "{own}");
}

/// The same suite on every lane (#538): each test above runs once per
/// ledger protocol the binary carries.
macro_rules! on_lane {
    ($lane:ident, $protocol:expr) => {
        mod $lane {
            #[test]
            fn count_is_zero_on_an_empty_instance() {
                super::count_is_zero_on_an_empty_instance($protocol)
            }
            #[test]
            fn a_session_claims_resolves_and_refuses_a_taken_handle() {
                super::a_session_claims_resolves_and_refuses_a_taken_handle($protocol)
            }
            #[test]
            fn a_dry_run_leaves_the_session_untouched_and_fees_are_stable() {
                super::a_dry_run_leaves_the_session_untouched_and_fees_are_stable($protocol)
            }
            #[test]
            fn a_wrong_argument_names_its_path() {
                super::a_wrong_argument_names_its_path($protocol)
            }
            #[test]
            fn the_first_call_fetches_and_an_identical_second_call_fetches_nothing() {
                super::the_first_call_fetches_and_an_identical_second_call_fetches_nothing(
                    $protocol,
                )
            }
            #[test]
            fn deny_mode_names_the_key_it_would_have_fetched() {
                super::deny_mode_names_the_key_it_would_have_fetched($protocol)
            }
            #[test]
            fn go_failing_a_fetch_fails_the_call_with_its_reason() {
                super::go_failing_a_fetch_fails_the_call_with_its_reason($protocol)
            }
            #[test]
            fn status_reports_the_open_ledger() {
                super::status_reports_the_open_ledger($protocol)
            }
            #[test]
            fn a_fork_fetches_its_network_config_when_it_opens() {
                super::a_fork_fetches_its_network_config_when_it_opens($protocol)
            }
            #[test]
            fn a_missing_config_setting_fails_the_open_and_names_it() {
                super::a_missing_config_setting_fails_the_open_and_names_it($protocol)
            }
            #[test]
            fn contract_info_reads_and_fetches_a_contract_without_running_it() {
                super::contract_info_reads_and_fetches_a_contract_without_running_it($protocol)
            }
            #[test]
            fn hot_swap_keeps_storage_and_runs_the_new_code() {
                super::hot_swap_keeps_storage_and_runs_the_new_code($protocol)
            }
            #[test]
            fn a_wasm_for_a_newer_protocol_is_refused() {
                super::a_wasm_for_a_newer_protocol_is_refused($protocol)
            }
            #[test]
            fn an_external_ref_swap_needs_an_explicit_mode() {
                super::an_external_ref_swap_needs_an_explicit_mode($protocol)
            }
            #[test]
            fn a_session_layer_swap_rolls_back() {
                super::a_session_layer_swap_rolls_back($protocol)
            }
            #[test]
            fn the_seed_is_derived_and_drives_env_prng() {
                super::the_seed_is_derived_and_drives_env_prng($protocol)
            }
            #[test]
            fn a_session_replays_byte_for_byte() {
                super::a_session_replays_byte_for_byte($protocol)
            }
            #[test]
            fn the_budget_stops_a_runaway_call_and_the_next_call_runs() {
                super::the_budget_stops_a_runaway_call_and_the_next_call_runs($protocol)
            }
            #[test]
            fn a_budget_override_is_capped_and_reported() {
                super::a_budget_override_is_capped_and_reported($protocol)
            }
            #[test]
            fn the_memory_guard_stops_the_process_with_resource_limit() {
                super::the_memory_guard_stops_the_process_with_resource_limit($protocol)
            }
            #[test]
            fn a_saved_session_is_restored_in_a_new_process() {
                super::a_saved_session_is_restored_in_a_new_process($protocol)
            }
            #[test]
            fn auth_modes_record_strict_and_enforce() {
                super::auth_modes_record_strict_and_enforce($protocol)
            }
            #[test]
            fn a_call_reports_the_contracts_it_reached_and_can_be_kept_to_its_own() {
                super::a_call_reports_the_contracts_it_reached_and_can_be_kept_to_its_own($protocol)
            }
            #[test]
            fn a_trace_shows_the_two_level_call_tree() {
                super::a_trace_shows_the_two_level_call_tree($protocol)
            }
            #[test]
            fn a_vesting_lock_opens_when_the_clock_is_moved() {
                super::a_vesting_lock_opens_when_the_clock_is_moved($protocol)
            }
            #[test]
            fn moving_past_a_ttl_archives_the_entry_and_the_call_restores_it() {
                super::moving_past_a_ttl_archives_the_entry_and_the_call_restores_it($protocol)
            }
        }
    };
}

#[cfg(feature = "lane-p28")]
on_lane!(p28, 28);
#[cfg(feature = "lane-p29")]
on_lane!(p29, 29);
