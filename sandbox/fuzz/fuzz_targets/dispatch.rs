//! `cargo +nightly fuzz run dispatch`: see sandbox/README.md. The body is
//! `signet_simulator::fuzzing::dispatch`, which tests/fuzz_smoke.rs also runs on stable.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| signet_simulator::fuzzing::dispatch(data));
