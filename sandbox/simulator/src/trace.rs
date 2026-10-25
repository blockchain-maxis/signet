//! Call traces for the visualiser (#541): `simulate` with `trace` returns
//! the call tree the host actually ran, in the shape of
//! `sandbox/protocol/schema/v1/trace.json`.
//!
//! The tree comes from the host's `fn_call` / `fn_return` diagnostic events
//! (the lane reads them, [`crate::lanes::Lane::trace_calls`]). Recording-mode
//! simulation builds its host internally and takes no `TraceHook`, so
//! per-frame instruction counts are not available; the call's total is in
//! `cost`. The footprint is per transaction, so storage is reported per
//! contract rather than per frame.

use std::collections::HashMap;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Map, Value};

use crate::lanes::{ByteSnapshotSource, Lane, SimulateResultBytes, TraceCall};
use crate::spec_verbs::wasm_of_contract;

/// The trace format's version; the visualiser pins the versions it reads.
pub const TRACE_SCHEMA_VERSION: u32 = 1;

/// Frames kept when the request names no cap.
pub const DEFAULT_MAX_FRAMES: usize = 10_000;

/// `trace: true` or `trace: {max_frames: N}`; `None` when absent or false.
pub fn parse(raw: Option<&Value>) -> Result<Option<usize>, &'static str> {
    const WANT: &str = "true, or an object with `max_frames` >= 1";
    match raw {
        None | Some(Value::Bool(false)) => Ok(None),
        Some(Value::Bool(true)) => Ok(Some(DEFAULT_MAX_FRAMES)),
        Some(Value::Object(o)) if o.keys().all(|k| k == "max_frames") => {
            match o.get("max_frames") {
                None => Ok(Some(DEFAULT_MAX_FRAMES)),
                Some(v) => match v.as_u64().filter(|n| *n >= 1) {
                    Some(n) => Ok(Some(usize::try_from(n).unwrap_or(usize::MAX))),
                    None => Err(WANT),
                },
            }
        }
        Some(_) => Err(WANT),
    }
}

/// The trace of one run. `root_args_xdr` are the arguments the call was
/// given, exact where the event's folding is ambiguous.
pub fn build(
    lane: &dyn Lane,
    src: &dyn ByteSnapshotSource,
    root_args_xdr: &[Vec<u8>],
    run: &SimulateResultBytes,
    max_frames: usize,
) -> Value {
    let calls = lane.trace_calls(&run.diagnostic_events_xdr);
    let truncated = calls.len() > max_frames;
    let mut arity: HashMap<(String, String), Option<usize>> = HashMap::new();
    let frames: Vec<Value> = calls
        .iter()
        .take(max_frames)
        .enumerate()
        .map(|(index, call)| {
            let (args, exact) = if index == 0 {
                (root_args_xdr.to_vec(), true)
            } else {
                let inputs = *arity
                    .entry((call.contract.clone(), call.function.clone()))
                    .or_insert_with(|| inputs(lane, src, call));
                args_of(call, inputs)
            };
            json!({
                "index": index,
                "parent": call.parent,
                "depth": call.depth,
                "contract": call.contract,
                "function": call.function,
                "args_xdr": args.iter().map(|a| BASE64.encode(a)).collect::<Vec<_>>(),
                "args_exact": exact,
                "result_xdr": call.result_xdr.as_ref().map(|r| BASE64.encode(r)),
                "error": call.error,
            })
        })
        .collect();
    json!({
        "version": TRACE_SCHEMA_VERSION,
        "source": "diagnostic_events",
        "frames": frames,
        "frame_count": calls.len(),
        "max_frames": max_frames,
        "truncated": truncated,
        "storage": storage(lane, &calls, run),
    })
}

/// How many inputs the callee's spec declares for the function, if it has
/// a spec (a Stellar asset contract has none).
fn inputs(lane: &dyn Lane, src: &dyn ByteSnapshotSource, call: &TraceCall) -> Option<usize> {
    let wasm = wasm_of_contract(src, lane, &call.contract).ok()?;
    let spec = lane.spec_document(&wasm).ok()?;
    spec["functions"]
        .as_array()?
        .iter()
        .find(|f| f["name"] == call.function.as_str())?["inputs"]
        .as_array()
        .map(Vec::len)
}

/// A nested call's arguments. The host records one argument as itself and
/// several as a vec, so a vec is one argument or several by the spec; with
/// no spec it is read as several, flagged inexact.
fn args_of(call: &TraceCall, inputs: Option<usize>) -> (Vec<Vec<u8>>, bool) {
    // ScVal::Void, the event's data for a call with no arguments.
    const VOID: [u8; 4] = [0, 0, 0, 1];
    match (&call.items_xdr, inputs) {
        (None, _) if call.data_xdr == VOID => (vec![], inputs.is_none_or(|n| n == 0)),
        (None, _) => (vec![call.data_xdr.clone()], true),
        (Some(_), Some(1)) => (vec![call.data_xdr.clone()], true),
        (Some(items), Some(n)) => (items.clone(), n == items.len()),
        (Some(items), None) => (items.clone(), false),
    }
}

/// The footprint by contract, in the order the trace first calls each:
/// what the call read, what it could write, and what it changed. Keys of no
/// one contract (code, accounts) come last under `contract: null`.
fn storage(lane: &dyn Lane, calls: &[TraceCall], run: &SimulateResultBytes) -> Vec<Value> {
    let (read_only, read_write) = run
        .transaction_data_xdr
        .as_ref()
        .and_then(|data| lane.transaction_resources(data).ok())
        .map(|r| (r.read_only, r.read_write))
        .unwrap_or_default();
    let changed: Vec<&Vec<u8>> = run
        .modified_entries
        .iter()
        .filter(|m| m.before_xdr != m.entry_xdr)
        .map(|m| &m.key_xdr)
        .collect();

    let mut order: Vec<Option<String>> = Vec::new();
    for call in calls {
        if !order.contains(&Some(call.contract.clone())) {
            order.push(Some(call.contract.clone()));
        }
    }
    let mut groups: HashMap<Option<String>, Map<String, Value>> = HashMap::new();
    let mut add = |field: &str, key: &[u8]| {
        let owner = lane.key_contract(key);
        if !order.contains(&owner) {
            order.push(owner.clone());
        }
        let group = groups.entry(owner).or_default();
        group
            .entry(field)
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("an array")
            .push(json!(BASE64.encode(key)));
    };
    for key in &read_only {
        add("read_only", key);
    }
    for key in &read_write {
        add("read_write", key);
    }
    for key in changed {
        add("changed", key);
    }
    // Contract-less keys last.
    order.sort_by_key(Option::is_none);
    order
        .into_iter()
        .filter_map(|owner| {
            let group = groups.remove(&owner)?;
            Some(json!({
                "contract": owner,
                "read_only": group.get("read_only").cloned().unwrap_or(json!([])),
                "read_write": group.get("read_write").cloned().unwrap_or(json!([])),
                "changed": group.get("changed").cloned().unwrap_or(json!([])),
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(items: Option<usize>, data: &[u8]) -> TraceCall {
        TraceCall {
            contract: "C".into(),
            function: "f".into(),
            parent: Some(0),
            depth: 1,
            data_xdr: data.to_vec(),
            items_xdr: items.map(|n| vec![vec![9]; n]),
            result_xdr: None,
            error: None,
        }
    }

    #[test]
    fn a_folded_vec_is_read_by_the_spec() {
        let vec = call(Some(2), &[1, 2, 3]);
        assert_eq!(args_of(&vec, Some(2)), (vec![vec![9], vec![9]], true));
        assert_eq!(
            args_of(&vec, Some(1)),
            (vec![vec![1, 2, 3]], true),
            "one vec argument"
        );
        assert_eq!(
            args_of(&vec, None),
            (vec![vec![9], vec![9]], false),
            "no spec: a guess"
        );
        assert_eq!(args_of(&call(None, &[0, 0, 0, 1]), Some(0)), (vec![], true));
        assert_eq!(args_of(&call(None, &[7]), None), (vec![vec![7]], true));
    }

    #[test]
    fn trace_takes_true_or_a_frame_cap() {
        assert_eq!(parse(None), Ok(None));
        assert_eq!(parse(Some(&json!(false))), Ok(None));
        assert_eq!(parse(Some(&json!(true))), Ok(Some(DEFAULT_MAX_FRAMES)));
        assert_eq!(parse(Some(&json!({ "max_frames": 3 }))), Ok(Some(3)));
        assert!(parse(Some(&json!({ "max_frames": 0 }))).is_err());
        assert!(parse(Some(&json!({ "frames": 3 }))).is_err());
        assert!(parse(Some(&json!("yes"))).is_err());
    }
}
