#![cfg(test)]

extern crate std;
use std::collections::BTreeMap;
use std::format;
use std::fs;
use std::path::Path;
use std::string::String as StdString;

use serde::{Deserialize, Serialize};

use super::*;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig},
    Address, Env, String, Vec,
};

/// Stated tolerance for resource regression checks:
/// - CPU instructions and memory bytes: 5% tolerance over baseline.
/// - Read/write entries and event/write bytes: no increase permitted (0% tolerance).
const INSTRUCTION_TOLERANCE_PERCENT: u64 = 5;
const MEMORY_TOLERANCE_PERCENT: u64 = 5;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct CostMetrics {
    pub cpu_instructions: u64,
    pub memory_bytes: u64,
    pub read_entries: u32,
    pub write_entries: u32,
    pub read_bytes: u32,
    pub write_bytes: u32,
    pub event_bytes: u32,
}

fn env() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

fn setup() -> (Env, IdentityRegistryClient<'static>, Address) {
    let env = env();
    env.mock_all_auths();
    let contract_id = env.register(IdentityRegistry, ());
    let client = IdentityRegistryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    client.initialize(&admin);
    (env, client, admin)
}

fn extract_metrics(env: &Env) -> CostMetrics {
    let res = env.cost_estimate().resources();
    CostMetrics {
        cpu_instructions: res.instructions as u64,
        memory_bytes: res.mem_bytes as u64,
        read_entries: res.memory_read_entries + res.disk_read_entries,
        write_entries: res.write_entries,
        read_bytes: res.disk_read_bytes,
        write_bytes: res.write_bytes,
        event_bytes: res.contract_events_size_bytes,
    }
}

fn measure_claim() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-claim");
    let wallet = Address::generate(&env);
    client.claim(&handle, &wallet);
    extract_metrics(&env)
}

fn measure_release() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-release");
    let wallet = Address::generate(&env);
    client.claim(&handle, &wallet);
    client.release(&handle);
    extract_metrics(&env)
}

fn measure_transfer_handle() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-transfer");
    let wallet1 = Address::generate(&env);
    let wallet2 = Address::generate(&env);
    client.claim(&handle, &wallet1);
    client.transfer_handle(&handle, &wallet2);
    extract_metrics(&env)
}

fn measure_admin_revoke() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-revoke");
    let wallet = Address::generate(&env);
    client.claim(&handle, &wallet);
    client.admin_revoke(&handle);
    extract_metrics(&env)
}

fn measure_set_admin() -> CostMetrics {
    let (env, client, _admin) = setup();
    let new_admin = Address::generate(&env);
    client.set_admin(&new_admin);
    extract_metrics(&env)
}

fn measure_resolve() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-resolve");
    let wallet = Address::generate(&env);
    client.claim(&handle, &wallet);
    client.resolve(&handle);
    extract_metrics(&env)
}

fn measure_lookup() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-lookup");
    let wallet = Address::generate(&env);
    client.claim(&handle, &wallet);
    client.lookup(&wallet);
    extract_metrics(&env)
}

fn measure_is_bound() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-isbound");
    let wallet = Address::generate(&env);
    client.claim(&handle, &wallet);
    client.is_bound(&handle);
    extract_metrics(&env)
}

fn measure_count() -> CostMetrics {
    let (env, client, _admin) = setup();
    let handle = String::from_str(&env, "cost-count");
    let wallet = Address::generate(&env);
    client.claim(&handle, &wallet);
    client.count();
    extract_metrics(&env)
}

fn measure_resolve_batch(n: usize) -> CostMetrics {
    let (env, client, _admin) = setup();
    let mut handles = Vec::new(&env);
    for i in 0..n {
        let handle_str = format!("user{i:03}");
        let h = String::from_str(&env, &handle_str);
        let w = Address::generate(&env);
        client.claim(&h, &w);
        handles.push_back(h);
    }
    client.resolve_batch(&handles);
    extract_metrics(&env)
}

fn collect_current_costs() -> BTreeMap<StdString, CostMetrics> {
    let mut costs = BTreeMap::new();
    costs.insert("claim".into(), measure_claim());
    costs.insert("release".into(), measure_release());
    costs.insert("transfer_handle".into(), measure_transfer_handle());
    costs.insert("admin_revoke".into(), measure_admin_revoke());
    costs.insert("set_admin".into(), measure_set_admin());
    costs.insert("resolve".into(), measure_resolve());
    costs.insert("lookup".into(), measure_lookup());
    costs.insert("is_bound".into(), measure_is_bound());
    costs.insert("count".into(), measure_count());
    costs.insert("resolve_batch_1".into(), measure_resolve_batch(1));
    costs.insert("resolve_batch_50".into(), measure_resolve_batch(50));
    costs.insert("resolve_batch_100".into(), measure_resolve_batch(100));
    costs
}

fn assert_within_tolerance(name: &str, current: &CostMetrics, baseline: &CostMetrics) {
    let max_cpu = baseline.cpu_instructions
        + (baseline.cpu_instructions * INSTRUCTION_TOLERANCE_PERCENT / 100);
    assert!(
        current.cpu_instructions <= max_cpu,
        "entry point '{name}' cpu_instructions exceeded tolerance: current={}, baseline={}, max_allowed={}",
        current.cpu_instructions,
        baseline.cpu_instructions,
        max_cpu
    );

    let max_mem = baseline.memory_bytes + (baseline.memory_bytes * MEMORY_TOLERANCE_PERCENT / 100);
    assert!(
        current.memory_bytes <= max_mem,
        "entry point '{name}' memory_bytes exceeded tolerance: current={}, baseline={}, max_allowed={}",
        current.memory_bytes,
        baseline.memory_bytes,
        max_mem
    );

    assert!(
        current.read_entries <= baseline.read_entries,
        "entry point '{name}' read_entries regression: current={}, baseline={}",
        current.read_entries,
        baseline.read_entries
    );

    assert!(
        current.write_entries <= baseline.write_entries,
        "entry point '{name}' write_entries regression: current={}, baseline={}",
        current.write_entries,
        baseline.write_entries
    );

    assert!(
        current.read_bytes <= baseline.read_bytes,
        "entry point '{name}' read_bytes regression: current={}, baseline={}",
        current.read_bytes,
        baseline.read_bytes
    );

    assert!(
        current.write_bytes <= baseline.write_bytes,
        "entry point '{name}' write_bytes regression: current={}, baseline={}",
        current.write_bytes,
        baseline.write_bytes
    );

    assert!(
        current.event_bytes <= baseline.event_bytes,
        "entry point '{name}' event_bytes regression: current={}, baseline={}",
        current.event_bytes,
        baseline.event_bytes
    );
}

#[test]
fn registry_costs_match_baseline() {
    let current = collect_current_costs();
    let baseline_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("cost_baseline.json");

    let should_update =
        std::env::var("UPDATE_GOLDEN").is_ok() || std::env::var("UPDATE_COST_BASELINE").is_ok();

    if should_update || !baseline_path.exists() {
        let mut json = serde_json::to_string_pretty(&current).unwrap();
        json.push('\n');
        fs::write(&baseline_path, json)
            .unwrap_or_else(|e| panic!("writing {}: {e}", baseline_path.display()));
        if should_update {
            return;
        }
    }

    let baseline_content = fs::read_to_string(&baseline_path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", baseline_path.display()));
    let baseline: BTreeMap<StdString, CostMetrics> = serde_json::from_str(&baseline_content)
        .unwrap_or_else(|e| panic!("parsing {}: {e}", baseline_path.display()));

    for (name, curr_metric) in &current {
        let base_metric = baseline
            .get(name)
            .unwrap_or_else(|| panic!("entry point '{name}' not found in cost_baseline.json"));
        assert_within_tolerance(name, curr_metric, base_metric);
    }
}
