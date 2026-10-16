# Sandbox Fixture Contracts

This directory contains purpose-built Soroban contracts and their pre-compiled WASM binaries used by the contract simulator and sandbox tests (Backlog ID `F-09`).

The WASMs are committed under [`wasm/`](./wasm) so host tests run without requiring the WASM build toolchain. A CI parity job verifies that the committed WASMs match a fresh build from source.

## Fixtures

| Fixture | Description and Calling Test |
|---|---|
| `counter_v1` | Simple counter with an `upgrade(hash)` entrypoint used by contract upgrade tests (`test_contract_upgrade_in_place`). |
| `counter_v2_return` | Counter variant returning `i128` instead of `u32` used by return type evolution tests (`test_diff_return_type_changed`). |
| `counter_v2_event` | Counter variant emitting an `Incremented` event used by event emission tests (`test_diff_event_added`). |
| `counter_v2_auth` | Counter variant requiring caller authorization via `require_auth` used by auth enforcement tests (`test_diff_auth_enforced`). |
| `counter_v2_cost` | Counter variant performing extra loop computations used by execution cost diff tests (`test_diff_cost_increased`). |
| `profile_v1` | Baseline stored `Profile { id, name }` struct used by state layout compatibility tests (`test_layout_baseline`). |
| `profile_v2_field` | Stored `Profile` struct gaining a non-Option `age` field used by breaking layout change tests (`test_layout_field_added_incompatible`). |
| `profile_v2_optional` | Stored `Profile` struct gaining an `Option<String>` `bio` field used by CAP-86 backward-compatible storage tests (`test_layout_field_added_compatible_optional`). |
| `callee` | Target contract exporting `add(a, b)` used by cross-contract invocation tests (`test_trace_cross_contract_callee`). |
| `caller` | Contract invoking `callee.add` used by cross-contract invocation trace tests (`test_trace_cross_contract_caller`). |
| `looper` | Contract running an infinite loop used by CPU instruction budget exhaustion tests (`test_budget_cpu_limit_exceeded`). |
| `hog` | Contract allocating vector memory in a loop used by memory budget limit tests (`test_budget_memory_limit_exceeded`). |
| `vesting` | Contract evaluating ledger timestamp against unlock times used by time-dependent ledger tests (`test_time_dependent_ledger_timestamp`). |

## Rebuilding

Run the build script from anywhere in the repository:

```bash
sandbox/fixtures/build.sh
```

Acceptance parity check:

```bash
sandbox/fixtures/build.sh && git diff --exit-code sandbox/fixtures/wasm
```
