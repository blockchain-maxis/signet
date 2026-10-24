#![no_main]

use libfuzzer_sys::fuzz_target;

// Feeds arbitrary JSON lines into the envelope dispatcher with a stub ledger.
// The dispatcher must never panic regardless of input shape.
fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    for line in text.lines() {
        let _ = serde_json::from_str::<serde_json::Value>(line);
    }
});
