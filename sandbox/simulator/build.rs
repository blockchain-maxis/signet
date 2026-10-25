//! Bakes the build's commit into the binary for `--version`, and checks the
//! lanes manifest (#591).
//!
//! Commit precedence: the `SIGNET_COMMIT` env var (release builds from a
//! tarball), then the short HEAD sha from git, then `unknown`; that part
//! never fails the build. The lanes check does: `lanes.toml` is the single
//! source of truth for which host each protocol runs, and a build whose
//! Cargo.toml pins disagree with it would answer for the wrong protocol.

use std::process::Command;

include!("build/lanes_check.rs");

fn main() {
    println!("cargo:rerun-if-env-changed=SIGNET_COMMIT");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=lanes.toml");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=../Cargo.toml");

    let commit = std::env::var("SIGNET_COMMIT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(git_commit)
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=SIGNET_SIMULATOR_COMMIT={commit}");

    let read = |p: &str| std::fs::read_to_string(p).unwrap_or_else(|e| panic!("reading {p}: {e}"));
    let lanes = parse_lanes(&read("lanes.toml")).unwrap_or_else(|e| panic!("{e}"));
    if let Err(e) = check(&lanes, &read("../Cargo.toml"), &read("Cargo.toml")) {
        panic!("{e}: update lanes.toml and the pins together (sandbox/README.md, \"Adding a protocol lane\")");
    }
}

fn git_commit() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!sha.is_empty()).then_some(sha)
}
