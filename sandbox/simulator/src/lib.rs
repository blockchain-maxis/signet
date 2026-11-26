//! `signet-simulator` as a library: the message loop and everything under it,
//! which the binary (`main.rs`) runs and the fuzz targets (`sandbox/fuzz`,
//! #525) drive through [`fuzzing`].

mod diff;
mod dispatch;
mod fidelity;
mod framing;
pub mod fuzzing;
mod lanes;
mod layout;
mod ledger;
pub mod memguard;
mod simulate;
mod snapshot;
mod spec_diff;
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
pub fn version_string() -> String {
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

/// The environment variable that sets the log filter, and what it is when
/// the variable is unset.
pub const LOG_ENV: &str = "SIGNET_SIMULATOR_LOG";
pub const DEFAULT_LOG_FILTER: &str = "warn";

/// The message every session starts with, as `--help` and `sandbox/README.md`
/// show it: one line, answered with `hello_ack`.
pub fn hello_example() -> String {
    format!(
        r#"{{"version":{v},"id":"hello","type":"hello","client_protocol_version":{v}}}"#,
        v = PROTOCOL_VERSION
    )
}

/// What `--help` prints (#936).
///
/// The `signet` CLI starts this binary, so someone who finds it in a release
/// archive or on `PATH` and runs it sees a process that waits and prints
/// nothing. The text says what the binary is, how it is driven, and what
/// changes its behaviour. The names and the defaults are the constants the
/// code reads, so the text cannot come apart from them.
pub fn help_text() -> String {
    format!(
        "\
{version}

The native contract simulator behind the `signet` CLI. `signet` starts it and
drives it over NDJSON: one JSON message per line on stdin, one answer per line
on stdout. Started by hand with no arguments it waits for a message, which
looks like a hang.

Usage:
  signet-simulator            run the message loop on stdin/stdout
  signet-simulator --version  print the build identity (also -V)
  signet-simulator --help     print this text (also -h)

To see it answer, send the message every session starts with:
  echo '{hello}' | signet-simulator

Environment:
  {log_env}
      Log filter for stderr: a level such as `debug`, or a tracing filter.
      Default: {log_default}
  {limit_env}
      Memory limit of the process, in bytes.
      Default: {limit_bytes} ({limit_gib} GiB)

The protocol is described in docs/CLI_RUST_BRIDGE.md.
",
        version = version_string(),
        hello = hello_example(),
        log_env = LOG_ENV,
        log_default = DEFAULT_LOG_FILTER,
        limit_env = memguard::LIMIT_ENV,
        limit_bytes = memguard::DEFAULT_LIMIT,
        limit_gib = memguard::DEFAULT_LIMIT >> 30,
    )
}

/// Logs go to stderr only (stdout is protocol data), at the level in
/// `SIGNET_SIMULATOR_LOG` (default `warn`).
fn init_logging() {
    let filter =
        EnvFilter::try_from_env(LOG_ENV).unwrap_or_else(|_| EnvFilter::new(DEFAULT_LOG_FILTER));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .with_ansi(false)
        .init();
}

/// The NDJSON message loop on stdin/stdout; the process's exit code.
pub fn run_message_loop() -> i32 {
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
