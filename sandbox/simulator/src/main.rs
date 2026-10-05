//! `signet-simulator`: the native contract simulator driven by the `signet`
//! CLI as a subprocess (docs/CLI_RUST_BRIDGE.md). This scaffold only answers
//! `--version`; the message protocol lands in #524 onward.

/// Wire protocol version the CLI handshake compares against.
const PROTOCOL_VERSION: u32 = 1;
/// Soroban lane count this build is pinned to.
const LANES: u32 = 28;

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
        None => {
            eprintln!("signet-simulator: no message loop yet; try --version");
            std::process::exit(2);
        }
    }
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
