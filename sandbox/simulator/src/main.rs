//! `signet-simulator`: the native contract simulator driven by the `signet`
//! CLI as a subprocess (docs/CLI_RUST_BRIDGE.md). With no arguments it runs the
//! NDJSON message loop on stdin/stdout; `--version` prints the build identity.

mod dispatch;
mod framing;

use std::io;

use tracing_subscriber::EnvFilter;

/// Wire protocol version the CLI handshake compares against.
pub(crate) const PROTOCOL_VERSION: u32 = 1;
/// Soroban lane count this build is pinned to.
pub(crate) const LANES: u32 = 28;
/// Pinned `soroban-env-host` and `soroban-simulation` versions (sandbox/Cargo.toml);
/// bump with them.
pub(crate) const ENV_HOST_VERSION: &str = "28.0.2";
pub(crate) const SIMULATION_VERSION: &str = "28.0.2";

/// `signet-simulator <semver> (commit <sha>) protocol 1 lanes 28`
fn version_string() -> String {
    format!(
        "signet-simulator {} (commit {}) protocol {} lanes {}",
        env!("CARGO_PKG_VERSION"),
        env!("SIGNET_SIMULATOR_COMMIT"),
        PROTOCOL_VERSION,
        LANES
    )
}

fn main() {
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
    let output = dispatch::Output::new(io::stdout());
    let mut dispatcher = dispatch::Dispatcher::new();
    dispatch::serve(
        io::stdin().lock(),
        &output,
        framing::MAX_LINE_BYTES,
        |line| dispatcher.handle(line),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_string_has_the_documented_shape() {
        let v = version_string();
        let prefix = format!("signet-simulator {} (commit ", env!("CARGO_PKG_VERSION"));
        assert!(v.starts_with(&prefix), "{v}");
        assert!(v.ends_with(") protocol 1 lanes 28"), "{v}");
    }

    #[test]
    fn commit_is_never_empty() {
        assert!(!env!("SIGNET_SIMULATOR_COMMIT").is_empty());
    }
}
