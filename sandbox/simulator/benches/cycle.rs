//! The reload cycle's steps (#638), through the real binary over stdio, as
//! `signet dev` drives them: the cost of the protocol is part of what a
//! developer waits for, so it is measured with the host.
//!
//! The contract is the registry (identity-registry.wasm, the size the
//! targets in docs/SANDBOX.md are set for) on a hand-built p28 ledger with
//! testnet's network config, initialized, then checkpointed as `base`, as
//! the reloader does.
//!
//! `cargo bench -p signet-simulator --bench cycle`; CI compares the
//! results with `benches/baseline.json` (scripts/check-bench.mjs).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use criterion::{criterion_group, criterion_main, Criterion};
use serde_json::{json, Value};

const TESTNET: &str = "Test SDF Network ; September 2015";
const ADMIN: &str = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const WALLET: &str = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const LANE: u32 = 28;
/// How many replays a cycle runs: the targets are for 20.
const REPLAYS: usize = 20;

fn manifest_path(rel: &str) -> String {
    format!("{}/{rel}", env!("CARGO_MANIFEST_DIR"))
}

/// Testnet's network config entries, as Go passes them to ledger_open.
fn network_config() -> Vec<Value> {
    let raw = std::fs::read_to_string(manifest_path("tests/fixtures/network-config-entries.json"))
        .unwrap();
    let recorded: Value = serde_json::from_str(&raw).unwrap();
    recorded["payload"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            json!({
                "key_xdr": e["key"], "data_xdr": e["xdr"],
                "last_modified_ledger_seq": e["lastModifiedLedgerSeq"],
                "ext_xdr": e.get("extXdr").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

fn registry_wasm() -> String {
    BASE64.encode(
        std::fs::read(manifest_path(
            "../../packages/spec/fixtures/identity-registry.wasm",
        ))
        .unwrap(),
    )
}

/// The simulator with Go's side played: requests out, every fetch answered
/// as absent (the ledger holds everything the calls read).
struct Sim {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

impl Sim {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn signet-simulator");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let mut sim = Self {
            child,
            stdin,
            stdout,
            next: 0,
        };
        let ack = sim.send(json!({ "type": "hello", "client_protocol_version": 1 }));
        assert_eq!(ack["type"], "hello_ack", "{ack}");
        sim
    }

    fn write(&mut self, message: &Value) {
        let mut line = message.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn send(&mut self, mut request: Value) -> Value {
        self.next += 1;
        request["version"] = json!(1);
        request["id"] = json!(format!("req-{}", self.next));
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
                self.write(&json!({ "version": 1, "id": reply["id"], "type": "ledger_entries", "entries": [] }));
                continue;
            }
            assert_eq!(reply["id"], id, "{reply}");
            return reply;
        }
    }

    /// send, and the reply must be a result.
    fn ok(&mut self, request: Value) -> Value {
        let reply = self.send(request);
        assert_eq!(reply["type"], "result", "{reply}");
        reply
    }

    fn open(&mut self, config: &[Value]) {
        self.ok(json!({
            "type": "ledger_open", "network_passphrase": TESTNET, "ledger_protocol": LANE,
            "sequence": 100, "timestamp": 1_790_000_000u64, "entries": config,
        }));
    }
}

impl Drop for Sim {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A warm session at `base`: the registry installed and initialized. Returns the contract, its executable's hash and the checkpoint.
fn session() -> (Sim, String, String, String) {
    let mut sim = Sim::start();
    sim.open(&network_config());
    let installed = sim.ok(json!({ "type": "contract_install", "wasm_base64": registry_wasm() }));
    let contract = installed["contract_id"].as_str().unwrap().to_string();
    let hash = installed["wasm_hash"].as_str().unwrap().to_string();
    sim.ok(json!({ "type": "simulate", "contract_id": contract, "function": "initialize", "args": { "admin": ADMIN } }));
    let base = sim.ok(json!({ "type": "ledger_checkpoint", "label": "base" }))["checkpoint"]
        .as_str()
        .unwrap()
        .to_string();
    (sim, contract, hash, base)
}

/// The cycle's replays: a read, a lookup and a write, in turn.
fn replay(contract: &str, i: usize) -> Value {
    let (function, args) = match i % 3 {
        0 => ("count", json!({})),
        1 => ("resolve", json!({ "handle": "alice" })),
        _ => (
            "claim",
            json!({ "handle": format!("user{i}"), "wallet": WALLET }),
        ),
    };
    json!({ "type": "simulate", "contract_id": contract, "function": function, "args": args, "call_index": i })
}

/// What diff_results compares for a call, as Go's DiffSideOf builds it.
fn side(result: &Value) -> Value {
    let mut storage = Vec::new();
    for m in result["modified_entries"].as_array().into_iter().flatten() {
        storage.push(json!({ "key_xdr": m["key_xdr"], "entry_xdr": m["after_xdr"] }));
    }
    json!({
        "outcome": "ok",
        "return_value_xdr": result["return_value_xdr"],
        "events": result["events"],
        "storage": storage,
        "auth": result["auth"],
        "resources": {
            "instructions": result["resources"]["instructions"],
            "mem_bytes": result["cost"]["mem_bytes"],
            "resource_fee": result["fee"]["resource_fee"],
        },
    })
}

fn cycle(c: &mut Criterion) {
    let config = network_config();
    let mut group = c.benchmark_group("cycle");
    group
        .sample_size(20)
        .measurement_time(Duration::from_secs(8));

    // Host spawn, handshake and ledger_open from a cached fork's entries.
    group.bench_function("cold_start", |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                let start = Instant::now();
                let mut sim = Sim::start();
                sim.open(&config);
                total += start.elapsed();
                drop(sim);
            }
            total
        })
    });

    let (mut sim, contract, hash, base) = session();

    // Back to base and the build swapped into the instance: what each
    // chain of B runs starts with.
    group.bench_function("swap", |b| {
        b.iter(|| {
            sim.ok(json!({ "type": "ledger_rollback", "checkpoint": base }));
            sim.ok(json!({ "type": "contract_swap", "contract_id": contract, "wasm_hash": hash }))
        })
    });

    for (name, trace) in [("simulate_claim", false), ("simulate_claim_traced", true)] {
        group.bench_function(name, |b| {
            b.iter(|| {
                sim.ok(json!({ "type": "ledger_rollback", "checkpoint": base }));
                let mut call = replay(&contract, 2);
                call["trace"] = json!(trace);
                sim.ok(call)
            })
        });
    }

    // A whole cycle's runs: every replay from base on A, then on B.
    group.bench_function("replays_20", |b| {
        b.iter(|| {
            for swap in [false, true] {
                for i in 0..REPLAYS {
                    sim.ok(json!({ "type": "ledger_rollback", "checkpoint": base }));
                    if swap {
                        sim.ok(json!({ "type": "contract_swap", "contract_id": contract, "wasm_hash": hash }));
                    }
                    sim.ok(replay(&contract, i));
                }
            }
        })
    });

    // Two claims that differ in return value, events, storage and auth.
    sim.ok(json!({ "type": "ledger_rollback", "checkpoint": base }));
    let a = side(&sim.ok(replay(&contract, 2)));
    sim.ok(json!({ "type": "ledger_rollback", "checkpoint": base }));
    let b_side = side(&sim.ok(replay(&contract, 5)));
    let request = json!({ "type": "diff_results", "ledger_protocol": LANE, "a": a, "b": b_side });
    let check = sim.ok(request.clone());
    assert_eq!(check["empty"], false, "{check}");
    group.bench_function("diff", |b| b.iter(|| sim.ok(request.clone())));

    group.finish();
}

criterion_group!(benches, cycle);
criterion_main!(benches);
