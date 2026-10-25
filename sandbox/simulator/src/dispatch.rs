//! Envelope parsing, the handshake, and the message loop
//! (docs/CLI_RUST_BRIDGE.md §2 and §3).
//!
//! [`Dispatcher`] turns one framed line into exactly one reply. [`serve`] runs
//! the loop around it: every line is handled inside `catch_unwind`, and a
//! panic ends the process with a best-effort `internal_panic` line, because
//! the state the panic interrupted may be inconsistent.

use std::any::Any;
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::time::Instant;

use serde_json::{json, Map, Value};

use crate::framing::Line;
use crate::lanes::LaneRegistry;
use crate::ledger::fetch::FetchingSource;
use crate::ledger::verbs::{
    ledger_checkpoint, ledger_get, ledger_open, ledger_put, ledger_rollback, OpenLedger,
};
use crate::simulate::{
    contract_info, contract_install, contract_swap, ledger_apply, ledger_import,
    load_network_config, simulate, status,
};
use crate::spec_verbs::{spec_decode_val, spec_encode_args, spec_extract};
use crate::stdio::Channel;
use crate::xdr_helpers::{entries_describe, tx_decode, wasm_inspect, xdr_keys};
use crate::PROTOCOL_VERSION;

/// Exit status after a panic in the message loop.
pub const PANIC_EXIT_CODE: i32 = 101;

/// What to do with one handled line: send `reply`, then exit if `exit` is set.
pub struct Step {
    pub reply: Value,
    pub exit: Option<i32>,
}

impl Step {
    fn reply(reply: Value) -> Self {
        Self { reply, exit: None }
    }
}

/// Builds an `error` message. `detail` always carries a machine-readable `kind`.
pub fn error_message(id: &Value, code: &str, message: String, detail: Value) -> Value {
    json!({
        "version": PROTOCOL_VERSION,
        "id": id,
        "type": "error",
        "code": code,
        "message": message,
        "detail": detail,
    })
}

fn bad_request(id: &Value, message: String, detail: Value) -> Step {
    Step::reply(error_message(id, "bad_request", message, detail))
}

fn invalid_field(id: &Value, path: &str, expected: &str) -> Step {
    bad_request(
        id,
        format!("`{path}` must be {expected}"),
        json!({ "kind": "invalid_field", "path": path, "expected": expected }),
    )
}

pub struct Dispatcher {
    greeted: bool,
    /// The session's open ledger, if any (`ledger_open`).
    ledger: Option<OpenLedger>,
    /// The stdio channel, for the `ledger_fetch`es a call needs (#531).
    channel: Rc<RefCell<Channel>>,
    started: Instant,
}

impl Dispatcher {
    pub fn new(channel: Rc<RefCell<Channel>>) -> Self {
        Self {
            greeted: false,
            ledger: None,
            channel,
            started: Instant::now(),
        }
    }

    pub fn handle(&mut self, line: Line) -> Step {
        let null = Value::Null;
        let bytes = match line {
            Line::TooLong => {
                return bad_request(
                    &null,
                    "line exceeds the maximum message length".to_string(),
                    json!({ "kind": "line_too_long" }),
                )
            }
            Line::Complete(bytes) => bytes,
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(e) => {
                return bad_request(
                    &null,
                    "line is not valid UTF-8".to_string(),
                    json!({ "kind": "invalid_utf8", "valid_up_to": e.valid_up_to() }),
                )
            }
        };
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(e) => {
                return bad_request(
                    &null,
                    format!("line is not valid JSON: {e}"),
                    json!({ "kind": "invalid_json", "line": e.line(), "column": e.column() }),
                )
            }
        };
        let Value::Object(object) = value else {
            return bad_request(
                &null,
                "a message is one JSON object per line".to_string(),
                json!({ "kind": "not_an_object" }),
            );
        };
        self.route(object)
    }

    fn route(&mut self, object: Map<String, Value>) -> Step {
        // Echo the id when it is usable, even if the rest of the envelope is not.
        let id = match object.get("id") {
            Some(id @ Value::String(_)) => id.clone(),
            Some(_) => return invalid_field(&Value::Null, "id", "a string"),
            None => return invalid_field(&Value::Null, "id", "present"),
        };
        let Some(version) = object.get("version").and_then(Value::as_u64) else {
            return invalid_field(&id, "version", "a non-negative integer");
        };
        let Some(ty) = object.get("type").and_then(Value::as_str) else {
            return invalid_field(&id, "type", "a string");
        };
        if version != u64::from(PROTOCOL_VERSION) {
            return Step::reply(error_message(
                &id,
                "unsupported_version",
                format!("this simulator speaks protocol {PROTOCOL_VERSION}, got {version}"),
                json!({
                    "kind": "version_mismatch",
                    "expected": PROTOCOL_VERSION,
                    "received": version,
                }),
            ));
        }
        if !self.greeted && ty != "hello" {
            return bad_request(
                &id,
                format!("the first message must be `hello`, got `{ty}`"),
                json!({ "kind": "handshake_required", "received_type": ty }),
            );
        }
        // Reads that miss the session's ledger go to Go through this source;
        // a fresh one per request, so `misses` are this request's.
        let fork = self.ledger.as_ref().map(|open| {
            Rc::new(FetchingSource::new(
                open.store.clone(),
                self.channel.clone(),
                open.lane,
                open.fetch,
            ))
        });
        match ty {
            "hello" => self.hello(&id, &object),
            "ledger_open" => Step::reply(self.open(&id, &object)),
            "ledger_put" => Step::reply(ledger_put(&mut self.ledger, &id, &object)),
            "ledger_get" => Step::reply(ledger_get(&self.ledger, &id, &object)),
            "ledger_checkpoint" => Step::reply(ledger_checkpoint(&mut self.ledger, &id)),
            "ledger_rollback" => Step::reply(ledger_rollback(&mut self.ledger, &id, &object)),
            "xdr_keys" => Step::reply(xdr_keys(&self.ledger, &id, &object)),
            "tx_decode" => Step::reply(tx_decode(&self.ledger, &id, &object)),
            "diff_results" => Step::reply(crate::diff::diff_results(&self.ledger, &id, &object)),
            "snapshot_read" => Step::reply(crate::snapshot::snapshot_read(&id, &object)),
            "storage_override" => Step::reply(crate::simulate::storage_override(
                &mut self.ledger,
                fork.as_ref(),
                &id,
                &object,
            )),
            "entries_describe" => Step::reply(entries_describe(&self.ledger, &id, &object)),
            "wasm_inspect" => Step::reply(wasm_inspect(&self.ledger, &id, &object)),
            "spec_extract" => {
                Step::reply(spec_extract(&self.ledger, fork.as_deref(), &id, &object))
            }
            "spec_encode_args" => Step::reply(spec_encode_args(
                &self.ledger,
                fork.as_deref(),
                &id,
                &object,
            )),
            "spec_decode_val" => {
                Step::reply(spec_decode_val(&self.ledger, fork.as_deref(), &id, &object))
            }
            "simulate" => Step::reply(simulate(&mut self.ledger, fork.as_ref(), &id, &object)),
            "contract_install" => Step::reply(contract_install(&mut self.ledger, &id, &object)),
            "contract_info" => {
                Step::reply(contract_info(&self.ledger, fork.as_ref(), &id, &object))
            }
            "contract_swap" => Step::reply(contract_swap(
                &mut self.ledger,
                fork.as_deref(),
                &id,
                &object,
            )),
            "ledger_import" => Step::reply(ledger_import(&mut self.ledger, &id, &object)),
            "ledger_apply" => Step::reply(ledger_apply(&mut self.ledger, &id, &object)),
            "status" => Step::reply(status(&self.ledger, self.started, &id)),
            "shutdown" => Step {
                reply: json!({ "version": PROTOCOL_VERSION, "id": id, "type": "result" }),
                exit: Some(0),
            },
            other => bad_request(
                &id,
                format!("unknown message type `{other}`"),
                json!({ "kind": "unknown_type", "type": other }),
            ),
        }
    }

    /// `ledger_open`, then the network config it must carry (#535). A ledger
    /// whose config is missing does not stay open.
    fn open(&mut self, id: &Value, object: &Map<String, Value>) -> Value {
        let mut reply = ledger_open(&mut self.ledger, id, object);
        if reply["type"] != "result" {
            return reply;
        }
        let Some(open) = self.ledger.as_mut() else {
            return reply;
        };
        let fork = Rc::new(FetchingSource::new(
            open.store.clone(),
            self.channel.clone(),
            open.lane,
            open.fetch,
        ));
        match load_network_config(open, &fork, id) {
            Ok(config) => {
                reply["network_config"] = config;
                reply
            }
            Err(error) => {
                self.ledger = None;
                error
            }
        }
    }

    fn hello(&mut self, id: &Value, object: &Map<String, Value>) -> Step {
        if self.greeted {
            return bad_request(
                id,
                "`hello` is only valid as the first message".to_string(),
                json!({ "kind": "already_greeted" }),
            );
        }
        if object
            .get("client_protocol_version")
            .and_then(Value::as_u64)
            .is_none()
        {
            return invalid_field(id, "client_protocol_version", "a non-negative integer");
        }
        self.greeted = true;
        let lanes: Vec<Value> = LaneRegistry::builtin()
            .lanes()
            .map(|lane| {
                json!({
                    "ledger_protocol": lane.ledger_protocol(),
                    "env_host": lane.env_host_version(),
                    "simulation": lane.simulation_version(),
                })
            })
            .collect();
        Step::reply(json!({
            "version": PROTOCOL_VERSION,
            "id": id,
            "type": "hello_ack",
            "server_protocol_version": PROTOCOL_VERSION,
            "simulator_version": env!("CARGO_PKG_VERSION"),
            "commit": env!("SIGNET_SIMULATOR_COMMIT"),
            "lanes": lanes,
        }))
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic with a non-string payload".to_string()
    }
}

/// Runs the message loop until EOF, `shutdown`, an I/O failure or a panic, and
/// returns the process exit code.
pub fn serve<H>(channel: &Rc<RefCell<Channel>>, mut handle: H) -> i32
where
    H: FnMut(Line) -> Step,
{
    loop {
        // The borrow ends before `handle` runs: a handler may fetch.
        let next = channel.borrow_mut().next_line();
        let line = match next {
            Ok(Some(line)) => line,
            Ok(None) => return 0,
            Err(e) => {
                tracing::error!("reading stdin failed: {e}");
                return 1;
            }
        };
        match catch_unwind(AssertUnwindSafe(|| handle(line))) {
            Ok(step) => {
                if let Err(e) = channel.borrow_mut().send(&step.reply) {
                    tracing::error!("writing to stdout failed: {e}");
                    return 1;
                }
                if let Some(code) = step.exit {
                    return code;
                }
            }
            Err(payload) => {
                let message = panic_message(payload.as_ref());
                tracing::error!("panic while handling a message: {message}");
                // Best effort: if this write fails too, Go's dead-pipe
                // handling is the backstop. A panic mid-fetch leaves the
                // channel unborrowed: the RefMut was dropped while unwinding.
                let _ = channel.borrow_mut().send(&error_message(
                    &Value::Null,
                    "internal_panic",
                    message,
                    json!({ "kind": "panic" }),
                ));
                return PANIC_EXIT_CODE;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::framing::MAX_LINE_BYTES;
    use crate::stdio::SharedBuf;

    const HELLO: &str = r#"{"version":1,"id":"hello","type":"hello","client_protocol_version":1}"#;

    fn channel(input: &[u8], max_line: usize) -> (Rc<RefCell<Channel>>, SharedBuf) {
        let out = SharedBuf::default();
        let channel = Channel::new(
            Box::new(std::io::Cursor::new(input.to_vec())),
            Box::new(out.clone()),
            max_line,
        );
        (Rc::new(RefCell::new(channel)), out)
    }

    /// Runs `input` through the real dispatcher; returns the replies and the exit code.
    fn run_with(input: &[u8], max_line: usize) -> (Vec<Value>, i32) {
        let (channel, out) = channel(input, max_line);
        let mut dispatcher = Dispatcher::new(channel.clone());
        let code = serve(&channel, |line| dispatcher.handle(line));
        let bytes = out.0.borrow().clone();
        (parse_output(bytes), code)
    }

    fn run(input: &str) -> (Vec<Value>, i32) {
        run_with(input.as_bytes(), MAX_LINE_BYTES)
    }

    fn parse_output(bytes: Vec<u8>) -> Vec<Value> {
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn assert_error(reply: &Value, code: &str, kind: &str) {
        assert_eq!(reply["type"], "error", "{reply}");
        assert_eq!(reply["code"], code, "{reply}");
        assert_eq!(reply["detail"]["kind"], kind, "{reply}");
        assert_eq!(reply["version"], PROTOCOL_VERSION);
    }

    #[cfg(all(feature = "lane-p28", feature = "lane-p29"))]
    #[test]
    fn hello_is_acked_and_end_of_input_exits_zero() {
        let (replies, code) = run(&format!("{HELLO}\n"));
        assert_eq!(code, 0);
        assert_eq!(replies.len(), 1);
        let ack = &replies[0];
        assert_eq!(ack["type"], "hello_ack");
        assert_eq!(ack["id"], "hello");
        assert_eq!(ack["version"], 1);
        assert_eq!(ack["server_protocol_version"], 1);
        assert_eq!(ack["simulator_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(ack["commit"], env!("SIGNET_SIMULATOR_COMMIT"));
        assert_eq!(ack["lanes"][0]["ledger_protocol"], 28);
        assert_eq!(ack["lanes"][0]["env_host"], "28.0.2");
        assert_eq!(ack["lanes"][0]["simulation"], "28.0.2");
        assert_eq!(ack["lanes"][1]["ledger_protocol"], 29);
        assert_eq!(ack["lanes"][1]["env_host"], "29.0.2");
    }

    #[cfg(all(feature = "lane-p28", feature = "lane-p29"))]
    #[test]
    fn ledger_open_at_protocol_30_is_unsupported_ledger_protocol() {
        let (replies, _) = run(&format!(
            "{HELLO}\n{}\n",
            r#"{"version":1,"id":"o1","type":"ledger_open","network_passphrase":"Test SDF Network ; September 2015","ledger_protocol":30}"#
        ));
        assert_error(
            &replies[1],
            "unsupported_ledger_protocol",
            "ledger_protocol",
        );
        assert_eq!(replies[1]["id"], "o1");
        assert_eq!(replies[1]["detail"]["requested"], 30);
        assert_eq!(replies[1]["detail"]["networkProtocol"], 30);
        assert_eq!(replies[1]["detail"]["supported"], json!([28, 29]));
    }

    #[test]
    fn a_first_message_other_than_hello_is_a_bad_request() {
        let (replies, _) = run(r#"{"version":1,"id":"r1","type":"shutdown"}"#);
        assert_error(&replies[0], "bad_request", "handshake_required");
        assert_eq!(replies[0]["id"], "r1");
    }

    #[test]
    fn a_second_hello_is_a_bad_request() {
        let (replies, _) = run(&format!("{HELLO}\n{HELLO}\n"));
        assert_eq!(replies[0]["type"], "hello_ack");
        assert_error(&replies[1], "bad_request", "already_greeted");
    }

    #[test]
    fn a_hello_without_the_client_version_names_the_field() {
        let (replies, _) = run(r#"{"version":1,"id":"h","type":"hello"}"#);
        assert_error(&replies[0], "bad_request", "invalid_field");
        assert_eq!(replies[0]["detail"]["path"], "client_protocol_version");
    }

    #[test]
    fn shutdown_answers_then_exits_zero_without_reading_more() {
        let input = format!(
            "{HELLO}\n{}\n{}\n",
            r#"{"version":1,"id":"bye","type":"shutdown"}"#,
            r#"{"version":1,"id":"late","type":"shutdown"}"#,
        );
        let (replies, code) = run(&input);
        assert_eq!(code, 0);
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[1]["type"], "result");
        assert_eq!(replies[1]["id"], "bye");
    }

    #[test]
    fn an_oversized_line_is_rejected_and_the_next_line_still_works() {
        let long = "x".repeat(200);
        let (replies, code) = run_with(format!("{long}\n{HELLO}\n").as_bytes(), 100);
        assert_eq!(code, 0);
        assert_error(&replies[0], "bad_request", "line_too_long");
        assert_eq!(replies[0]["id"], Value::Null);
        assert_eq!(replies[1]["type"], "hello_ack");
    }

    #[test]
    fn invalid_utf8_is_a_bad_request_and_the_loop_continues() {
        let mut input = b"{\"id\":\"\xff\"}\n".to_vec();
        input.extend_from_slice(HELLO.as_bytes());
        input.push(b'\n');
        let (replies, _) = run_with(&input, MAX_LINE_BYTES);
        assert_error(&replies[0], "bad_request", "invalid_utf8");
        assert_eq!(replies[1]["type"], "hello_ack");
    }

    #[test]
    fn a_json_array_is_rejected_because_a_message_is_one_object() {
        let (replies, _) = run("[1,2,3]\n");
        assert_error(&replies[0], "bad_request", "not_an_object");
    }

    #[test]
    fn invalid_json_and_blank_lines_are_bad_requests() {
        let (replies, _) = run("{not json\n\n");
        assert_error(&replies[0], "bad_request", "invalid_json");
        assert_error(&replies[1], "bad_request", "invalid_json");
    }

    #[test]
    fn an_unknown_type_is_a_bad_request_that_echoes_the_id() {
        let (replies, _) = run(&format!(
            "{HELLO}\n{}\n",
            r#"{"version":1,"id":"r9","type":"frobnicate"}"#
        ));
        assert_error(&replies[1], "bad_request", "unknown_type");
        assert_eq!(replies[1]["id"], "r9");
        assert_eq!(replies[1]["detail"]["type"], "frobnicate");
    }

    #[test]
    fn a_bad_field_reports_its_path() {
        let (replies, _) = run(r#"{"version":1,"id":"r1","type":7}"#);
        assert_error(&replies[0], "bad_request", "invalid_field");
        assert_eq!(replies[0]["detail"]["path"], "type");
        assert_eq!(replies[0]["id"], "r1");
    }

    #[test]
    fn a_wrong_version_mid_session_is_unsupported_version() {
        let (replies, _) = run(&format!(
            "{HELLO}\n{}\n",
            r#"{"version":2,"id":"r2","type":"shutdown"}"#
        ));
        assert_eq!(replies[0]["type"], "hello_ack");
        assert_error(&replies[1], "unsupported_version", "version_mismatch");
        assert_eq!(replies[1]["id"], "r2");
        assert_eq!(replies[1]["detail"]["expected"], 1);
        assert_eq!(replies[1]["detail"]["received"], 2);
    }

    #[test]
    fn a_handler_panic_writes_internal_panic_and_exits_non_zero() {
        let (channel, out) = channel(format!("{HELLO}\n{HELLO}\n").as_bytes(), MAX_LINE_BYTES);
        let code = serve(&channel, |_| panic!("boom"));
        assert_ne!(code, 0);
        assert_eq!(code, PANIC_EXIT_CODE);
        let replies = parse_output(out.0.borrow().clone());
        // The loop stops at the first panic: one line, not one per input line.
        assert_eq!(replies.len(), 1);
        assert_error(&replies[0], "internal_panic", "panic");
        assert_eq!(replies[0]["message"], "boom");
    }
}
