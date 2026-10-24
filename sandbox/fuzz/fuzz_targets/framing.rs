#![no_main]

use libfuzzer_sys::fuzz_target;
use std::io::{BufRead, BufReader, Cursor};

// Feeds arbitrary bytes into the line reader used by the sandbox framing layer.
// Every line is read with a bounded length so oversized frames cannot exhaust memory.
const MAX_LINE: usize = 1 << 20;

fuzz_target!(|data: &[u8]| {
    let mut reader = BufReader::new(Cursor::new(data));
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut limited = (&mut reader).take(MAX_LINE as u64);
        match limited.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(_) => {
                let _ = std::str::from_utf8(&line);
            }
            Err(_) => break,
        }
    }
});
