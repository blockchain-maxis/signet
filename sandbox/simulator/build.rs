//! Bakes the build's commit into the binary for `--version`.
//!
//! Precedence: the `SIGNET_COMMIT` env var (release builds from a tarball),
//! then the short HEAD sha from git, then `unknown`. Never fails the build.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=SIGNET_COMMIT");
    println!("cargo:rerun-if-changed=../../.git/HEAD");

    let commit = std::env::var("SIGNET_COMMIT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(git_commit)
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=SIGNET_SIMULATOR_COMMIT={commit}");
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
