//! `signet-simulator`: the native contract simulator driven by the `signet`
//! CLI as a subprocess (docs/CLI_RUST_BRIDGE.md). With no arguments it runs the
//! NDJSON message loop on stdin/stdout; `--version` prints the build identity.
//! The work is in the library (`lib.rs`).

use signet_simulator::{memguard, run_message_loop, version_string};

/// Every allocation is counted against the process memory limit (#536).
#[global_allocator]
static GLOBAL: memguard::Guard = memguard::Guard;

fn main() {
    memguard::configure();
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") | Some("-V") => println!("{}", version_string()),
        Some(other) => {
            eprintln!("signet-simulator: unknown argument `{other}` (try --version)");
            std::process::exit(2);
        }
        None => std::process::exit(run_message_loop()),
    }
}
