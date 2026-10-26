//! Entry points for the fuzz targets (#525, `sandbox/fuzz`).
//!
//! The simulator parses what a separate process sends it, and that process
//! relays data from RPC nodes and from repro bundles other people wrote. Each
//! function here takes arbitrary bytes and must return without panicking,
//! overflowing the stack or looping: a crash is a bug. They are plain
//! functions so the same inputs also run on stable in `tests/fuzz_smoke.rs`.

use std::cell::RefCell;
use std::io::{self, Cursor};
use std::rc::Rc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

use crate::dispatch::Dispatcher;
use crate::framing::{Line, LineReader};
use crate::stdio::Channel;

/// `framing`: arbitrary bytes into the line reader, at a small limit (so
/// over-long lines are common) and at the real one. Every line it yields
/// fits the limit and holds no newline, and the reader always ends.
pub fn framing(data: &[u8]) {
    for max in [16, 4096, crate::framing::MAX_LINE_BYTES] {
        // A small buffer, so lines straddle refills.
        let reader = io::BufReader::with_capacity(7, Cursor::new(data));
        let mut lines = LineReader::new(reader, max);
        let mut count = 0usize;
        while let Some(line) = lines.next_line().expect("reading from memory cannot fail") {
            if let Line::Complete(bytes) = &line {
                assert!(bytes.len() <= max, "a line over the limit was returned");
                assert!(!bytes.contains(&b'\n'), "a line kept its newline");
            }
            count += 1;
            assert!(count <= data.len() + 1, "more lines than bytes");
        }
    }
}

/// A dispatcher whose channel has nothing to read (every `ledger_fetch`
/// finds the stream closed) and writes into the void: the stub ledger.
fn dispatcher() -> Dispatcher {
    let channel = Rc::new(RefCell::new(Channel::new(
        Box::new(Cursor::new(Vec::new())),
        Box::new(io::sink()),
        crate::framing::MAX_LINE_BYTES,
    )));
    Dispatcher::new(channel)
}

fn send(dispatcher: &mut Dispatcher, message: &Value) -> bool {
    let step = dispatcher.handle(Line::Complete(message.to_string().into_bytes()));
    step.exit.is_none()
}

fn hello(dispatcher: &mut Dispatcher) {
    send(
        dispatcher,
        &json!({ "version": 1, "id": "hello", "type": "hello", "client_protocol_version": 1 }),
    );
}

/// `dispatch`: arbitrary JSON lines into the envelope dispatcher, after the
/// handshake. Each line must get a reply; a `shutdown` ends the session.
pub fn dispatch(data: &[u8]) {
    let mut dispatcher = dispatcher();
    hello(&mut dispatcher);
    let mut lines = LineReader::new(Cursor::new(data), 1 << 20);
    while let Ok(Some(line)) = lines.next_line() {
        let step = dispatcher.handle(line);
        assert!(step.reply.is_object(), "every line gets a message back");
        if step.exit.is_some() {
            break;
        }
    }
}

/// The requests whose parameters carry XDR, each with `x` (base64 of the
/// fuzz input) in every XDR field it has. `lane` alternates the ledger
/// protocol, since each lane decodes with its own XDR crate.
fn xdr_requests(x: &str, lane: u32) -> Vec<Value> {
    let side = json!({
        "outcome": "ok",
        "return_value_xdr": x,
        "events": [{ "event_xdr": x }],
        "storage": [{ "key_xdr": x, "entry_xdr": x }],
        "auth": [],
        "resources": { "instructions": 1, "mem_bytes": 1, "resource_fee": 1 },
    });
    let entries = json!([
        { "key_xdr": x, "entry_xdr": x },
        { "key_xdr": x, "data_xdr": x, "last_modified_ledger_seq": 1, "ext_xdr": x },
    ]);
    vec![
        json!({ "type": "tx_decode", "ledger_protocol": lane, "transaction_xdr": x }),
        json!({ "type": "tx_decode", "ledger_protocol": lane, "transaction_xdr": x, "result_meta_xdr": x }),
        json!({ "type": "tx_resources", "ledger_protocol": lane, "transaction_data_xdr": x }),
        json!({ "type": "entries_describe", "ledger_protocol": lane, "entries": [{ "data_xdr": x, "ext_xdr": x }] }),
        json!({ "type": "diff_results", "ledger_protocol": lane, "a": side, "b": side }),
        json!({ "type": "wasm_inspect", "ledger_protocol": lane, "wasm_base64": x }),
        json!({
            "type": "ledger_open",
            "network_passphrase": "Test SDF Network ; September 2015",
            "ledger_protocol": lane,
            "sequence": 100,
            "timestamp": 1_790_000_000u64,
            "entries": entries,
        }),
        json!({ "type": "ledger_put", "entries": entries }),
        json!({ "type": "ledger_get", "keys_xdr": [x] }),
        json!({ "type": "layout_check", "entries": [{ "key_xdr": x, "entry_xdr": x }] }),
        json!({ "type": "contract_install", "wasm_base64": x }),
        json!({ "type": "spec_extract", "source": { "wasm_base64": x } }),
    ]
}

/// `xdr_params`: the fuzz input as the bytes of every request parameter that
/// decodes XDR, in both lanes. The first byte picks the lane, so the
/// fuzzer can steer.
pub fn xdr_params(data: &[u8]) {
    let (lane, bytes) = match data.split_first() {
        Some((first, rest)) => (if first & 1 == 0 { 28 } else { 29 }, rest),
        None => (28, data),
    };
    let x = BASE64.encode(bytes);
    let mut dispatcher = dispatcher();
    hello(&mut dispatcher);
    for (n, mut request) in xdr_requests(&x, lane).into_iter().enumerate() {
        request["version"] = json!(1);
        request["id"] = json!(format!("x-{n}"));
        if !send(&mut dispatcher, &request) {
            break;
        }
    }
}
