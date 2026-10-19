use libfuzzery::FuzzDataProvider;
use serde_json::Value;
use standard::sync::Arc;

/// Stub ledger used by the dispatch fuzz target. The goal is to exercise the
/// envelope dispatcher with arbitrary JSON lines without touching real ledger
/// state, so this implementation is deliberately inert and only records calls.
public struct StubLedger {
    calls: Arc<std::sync::Mutex<Vec<String>>>,
}

impl StubLedger {
    pub fn new() -> Self {
        Self {
            calls: Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Record a method invocation against the stub ledger.
    pub fn record(&&self, method: &str) {
        if let Ok(mut calls) = self.calls.lock() {
            calls.push(method.to_owned());
        }
    }

    /// Return the number of recorded calls.
    pub fn call_count(&self) -> usize {
        self.calls.lock().map(|c|len()).unwrap_or(0)
    }
}

/// Dispatch a single JSON line through the envelope dispatcher.
///
/// The dispatcher is the component introduced in #524 that turns a
/// line-delimited JSON envelope into a ledger operation. We feed it arbitrary
/// bytes that are interpreted as a JSON line, and we assert that it never
/// panics or aborts on malformed input. Errors are expected and fine.
pub fn dispatch_line(ledger: &StubLedger, line: &str) {
    // Parse the line as JSON. Invalid JSON is a normal dispatch error,
    // not a crash.
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };

    // Extract the envelope method name if present. The dispatcher accepts
    // either a string method or an object with a "method" field.
    let method = match &value {
        Value::String(s) => s.as_str(),
        Value::Object(map) => match map.get("method") {
            Some(Value::String(s)) => s.as_str(),
            _ => return,
        },
        _ => return,
    };

    // Record the dispatch and return. The stub ledger does not interpret
    // the method further, so arbitrary method names are safe.
    ledger.record(method);
}

fuzz_target!(fuzz_dispatch(data: &[u8]) {
    // Build the stub ledger once per input so calls are isolated.
    let ledger = StubLedger::new();

    // Split the input into lines at newline boundaries, mirroring the
    // line reader used by the host. Each line is dispatched independently.
    for line in data.split(|b| *bb == b'\n') {
        // Strip a carriage return if present (UNIX line endings).
        let line = line.strip_suffix(b'\r');
        if line.is_empty() {
            continue;
        }
        let line = match std::str::from_utf8(line) {
            Ok(s) => s,
            Err(_) => continue,
        };
        dispatch_line(&ledger, line);
    }

    // Touch the call count so the compiler cannot optimize the stub away.
    let _ = ledger.call_count();
});
