//! The binary's own arguments (#936), through the real binary.
//!
//! `signet` starts the simulator, so its command line is small: no argument
//! runs the message loop, `--version` prints the build identity, and `--help`
//! is what someone who finds the binary on its own can ask it.

use std::io::Write;
use std::process::{Command, Output, Stdio};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("run signet-simulator")
}

fn stdout(out: &Output) -> String {
    String::from_utf8(out.stdout.clone()).expect("stdout is UTF-8")
}

fn stderr(out: &Output) -> String {
    String::from_utf8(out.stderr.clone()).expect("stderr is UTF-8")
}

/// The JSON line the help text shows after `echo '`.
fn hello_line(help: &str) -> &str {
    let start = help.find("echo '").expect("the help shows an echo example") + "echo '".len();
    let end = start + help[start..].find('\'').expect("the example is closed");
    &help[start..end]
}

#[test]
fn help_and_h_print_the_usage_on_stdout_and_exit_zero() {
    for flag in ["--help", "-h"] {
        let out = run(&[flag]);
        assert_eq!(out.status.code(), Some(0), "{flag}");
        assert!(stderr(&out).is_empty(), "{flag} wrote to stderr");
        let text = stdout(&out);
        for needle in [
            // What it is and how it is driven.
            "`signet` CLI",
            "NDJSON",
            "stdin",
            "stdout",
            // The other argument, and this one.
            "--version",
            "--help",
            // The two variables, with their defaults.
            "SIGNET_SIMULATOR_LOG",
            "Default: warn",
            "SIGNET_SIMULATOR_MEMORY_LIMIT",
            "Default: 2147483648 (2 GiB)",
        ] {
            assert!(text.contains(needle), "{flag}: no `{needle}` in:\n{text}");
        }
    }
    assert_eq!(stdout(&run(&["--help"])), stdout(&run(&["-h"])));
}

#[test]
fn the_help_starts_with_the_build_identity_version_prints() {
    let version = stdout(&run(&["--version"]));
    assert!(version.starts_with("signet-simulator "), "{version}");
    assert_eq!(stdout(&run(&["-V"])), version);
    let help = stdout(&run(&["--help"]));
    assert_eq!(help.lines().next(), Some(version.trim_end()));
}

#[test]
fn the_example_in_the_help_is_answered_with_hello_ack() {
    let help = stdout(&run(&["--help"]));
    let hello = hello_line(&help);

    let mut child = Command::new(env!("CARGO_BIN_EXE_signet-simulator"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn signet-simulator");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{hello}\n").as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    let reply: serde_json::Value =
        serde_json::from_str(stdout(&out).lines().next().expect("one reply")).unwrap();
    assert_eq!(reply["type"], "hello_ack", "{reply}");
    assert_eq!(reply["id"], "hello", "{reply}");
}

#[test]
fn the_example_in_the_help_is_the_one_in_the_readme() {
    let readme = std::fs::read_to_string(format!("{}/../README.md", env!("CARGO_MANIFEST_DIR")))
        .expect("sandbox/README.md");
    let help = stdout(&run(&["--help"]));
    let hello = hello_line(&help);
    assert!(
        readme.contains(&format!("echo '{hello}'")),
        "sandbox/README.md does not show `{hello}`"
    );
}

#[test]
fn an_unknown_argument_exits_2_and_points_to_help() {
    for arg in ["--bogus", "help", "-help", "--Help", ""] {
        let out = run(&[arg]);
        assert_eq!(out.status.code(), Some(2), "`{arg}`");
        assert!(stdout(&out).is_empty(), "`{arg}` wrote to stdout");
        let message = stderr(&out);
        assert!(
            message.contains(&format!("unknown argument `{arg}`")),
            "`{arg}`: {message}"
        );
        assert!(message.contains("--help"), "`{arg}`: {message}");
    }
}
