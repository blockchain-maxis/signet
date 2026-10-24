#![no_main]

use base64::Engine;
use libfuzzer_sys::fuzz_target;
use stellar_xdr::curr::{Limited, Limits, ReadXdr, ScVal};

// Decodes arbitrary base64 as an ScVal with explicit depth and length limits,
// mirroring the single host XDR helper.
const MAX_DEPTH: u32 = 64;
const MAX_LEN: usize = 1 << 20;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(text) else {
        return;
    };
    let mut limited = Limited::new(
        std::io::Cursor::new(bytes),
        Limits {
            depth: MAX_DEPTH,
            len: MAX_LEN,
        },
    );
    let _ = ScVal::read_xdr(&mut limited);
});
