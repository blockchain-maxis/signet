//! `signet-simulator`: the native contract simulator driven by the `signet`
//! CLI as a subprocess (docs/CLI_RUST_BRIDGE.md). With no arguments it runs the
//! NDJSON message loop on stdin/stdout; `--version` prints the build identity.

mod dispatch;
mod framing;
mod lanes;
mod ledger;
mod memguard;
mod simulate;
mod spec_verbs;
mod stdio;
mod trace;
mod xdr_helpers;

use std::cell::RefCell;
use std::io;
use std::rc::Rc;

use tracing_subscriber::EnvFilter;

/// Wire protocol version the CLI handshake compares against.
pub(crate) const PROTOCOL_VERSION: u32 = 1;

/// `signet-simulator <semver> (commit <sha>) protocol 1 lanes 28`; with more
/// lanes, their ledger protocols comma-separated (`lanes 28,29`).
fn version_string() -> String {
    let lanes: Vec<String> = lanes::LaneRegistry::builtin()
        .supported()
        .iter()
        .map(u32::to_string)
        .collect();
    format!(
        "signet-simulator {} (commit {}) protocol {} lanes {}",
        env!("CARGO_PKG_VERSION"),
        env!("SIGNET_SIMULATOR_COMMIT"),
        PROTOCOL_VERSION,
        lanes.join(",")
    )
}

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

/// Logs go to stderr only (stdout is protocol data), at the level in
/// `SIGNET_SIMULATOR_LOG` (default `warn`).
fn init_logging() {
    let filter =
        EnvFilter::try_from_env("SIGNET_SIMULATOR_LOG").unwrap_or_else(|_| EnvFilter::new("warn"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .with_ansi(false)
        .init();
}

fn run_message_loop() -> i32 {
    init_logging();
    let channel = Rc::new(RefCell::new(stdio::Channel::new(
        Box::new(io::stdin().lock()),
        Box::new(io::stdout()),
        framing::MAX_LINE_BYTES,
    )));
    let mut dispatcher = dispatch::Dispatcher::new(channel.clone());
    dispatch::serve(&channel, |line| dispatcher.handle(line))
}

// The version string's lane list is the release build's.
#[cfg(all(test, feature = "lane-p28", feature = "lane-p29"))]
mod tests {
    use super::*;

    #[test]
    fn version_string_has_the_documented_shape() {
        let v = version_string();
        let prefix = format!("signet-simulator {} (commit ", env!("CARGO_PKG_VERSION"));
        assert!(v.starts_with(&prefix), "{v}");
        assert!(v.ends_with(") protocol 1 lanes 28,29"), "{v}");
    }

    #[test]
    fn commit_is_never_empty() {
        assert!(!env!("SIGNET_SIMULATOR_COMMIT").is_empty());
    }
}
