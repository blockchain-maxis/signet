//! Envelope parsing, the handshake, and the message loop
//! (docs/CLI_RUST_BRIDGE.md §2 and §3).
//!
//! [`Dispatcher`] turns one framed line into exactly one reply. [`serve`] runs
//! the loop around it: every line is handled inside `catch_unwind`, and a
//! panic ends the process with a best-effort `internal_panic` line, because
//! the state the panic interrupted may be inconsistent.

use std::any::Any;
use std::io::{self, BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::framing::{Line, LineReader};
use crate::{ENV_HOST_VERSION, LANES, PROTOCOL_VERSION, SIMULATION_VERSION};

/// Exit status after a panic in the message loop.
pub const PANIC_EXIT_CODE: i32 = 101;

/// The single serialised writer for protocol output: one JSON object and a
/// newline per call, flushed, under a lock so lines never interleave.
pub struct Output<W> {
    inner: Mutex<W>,
}

impl<W: Write> Output<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner: Mutex::new(inner),
        }
    }

    pub fn send(&self, message: &Value) -> io::Result<()> {
        let mut line = serde_json::to_vec(message).map_err(io::Error::other)?;
        line.push(b'\n');
        // A poisoned lock only means a writer panicked; the stream is still
        // usable for the best-effort `internal_panic` line.
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.write_all(&line)?;
        inner.flush()
    }

    /// Consumes the writer, returning what was written to it.
    #[cfg(test)]
    pub fn into_inner(self) -> W {
        self.inner.into_inner().unwrap_or_else(|e| e.into_inner())
    }
}

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

#[derive(Default)]
pub struct Dispatcher {
    greeted: bool,
}

impl Dispatcher {
    pub fn new() -> Self {
        Self::default()
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
        match ty {
            "hello" => self.hello(&id, &object),
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
        Step::reply(json!({
            "version": PROTOCOL_VERSION,
            "id": id,
            "type": "hello_ack",
            "server_protocol_version": PROTOCOL_VERSION,
            "simulator_version": env!("CARGO_PKG_VERSION"),
            "commit": env!("SIGNET_SIMULATOR_COMMIT"),
            "lanes": [{
                "ledger_protocol": LANES,
                "env_host": ENV_HOST_VERSION,
                "simulation": SIMULATION_VERSION,
            }],
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
pub fn serve<R, W, H>(input: R, output: &Output<W>, max_line: usize, mut handle: H) -> i32
where
    R: BufRead,
    W: Write,
    H: FnMut(Line) -> Step,
{
    let mut reader = LineReader::new(input, max_line);
    loop {
        let line = match reader.next_line() {
            Ok(Some(line)) => line,
            Ok(None) => return 0,
            Err(e) => {
                tracing::error!("reading stdin failed: {e}");
                return 1;
            }
        };
        match catch_unwind(AssertUnwindSafe(|| handle(line))) {
            Ok(step) => {
                if let Err(e) = output.send(&step.reply) {
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
                // handling is the backstop.
                let _ = output.send(&error_message(
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

    const HELLO: &str = r#"{"version":1,"id":"hello","type":"hello","client_protocol_version":1}"#;

    /// Runs `input` through the real dispatcher; returns the replies and the exit code.
    fn run_with(input: &[u8], max_line: usize) -> (Vec<Value>, i32) {
        let output = Output::new(Vec::new());
        let mut dispatcher = Dispatcher::new();
        let code = serve(input, &output, max_line, |line| dispatcher.handle(line));
        (parse_output(output.into_inner()), code)
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
        assert_eq!(ack["lanes"][0]["ledger_protocol"], LANES);
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
        let output = Output::new(Vec::new());
        let code = serve(
            format!("{HELLO}\n{HELLO}\n").as_bytes(),
            &output,
            MAX_LINE_BYTES,
            |_| panic!("boom"),
        );
        assert_ne!(code, 0);
        assert_eq!(code, PANIC_EXIT_CODE);
        let replies = parse_output(output.into_inner());
        // The loop stops at the first panic: one line, not one per input line.
        assert_eq!(replies.len(), 1);
        assert_error(&replies[0], "internal_panic", "panic");
        assert_eq!(replies[0]["message"], "boom");
    }
}
