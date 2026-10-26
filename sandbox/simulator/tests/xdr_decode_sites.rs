//! XDR from outside the process is decoded in one place per lane (#525):
//! `decode_xdr` and `xdr_reader` in `src/lanes/host_lane.rs`, under
//! `DECODE_LIMITS`. This holds every other line of non-test source to that,
//! so a new decode with `Limits::none()` (no depth or length limit) fails
//! here instead of in production.

use std::path::{Path, PathBuf};

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// A file's lines up to its first `#[cfg(test)]` module: the code that ships.
fn shipped_lines(path: &Path) -> Vec<(usize, String)> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .take_while(|line| !line.trim_start().starts_with("#[cfg(test)]"))
        .enumerate()
        .map(|(n, line)| (n + 1, line.to_string()))
        .collect()
}

#[test]
fn every_xdr_decode_goes_through_the_limited_helper() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    let helper = root.join("lanes/host_lane.rs");
    let mut offenders = Vec::new();
    for file in &files {
        for (n, line) in shipped_lines(file) {
            let code = line.split("//").next().unwrap_or("");
            let at = format!("{}:{n}: {}", file.display(), line.trim());
            let in_helper = file == &helper
                && (code.contains("T::from_xdr(bytes, DECODE_LIMITS)")
                    || code.contains("Limited::new(Cursor::new(bytes), DECODE_LIMITS)"));
            if (code.contains("from_xdr") || code.contains("Limited::new(")) && !in_helper {
                offenders.push(at);
            } else if code.contains("Limits::none()") && !code.contains("to_xdr") {
                // Unlimited is only for writing XDR this process built.
                offenders.push(at);
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "decode XDR through decode_xdr / xdr_reader (DECODE_LIMITS), not directly:\n{}",
        offenders.join("\n")
    );
}

#[test]
fn the_helper_is_where_this_test_expects_it() {
    let lines =
        shipped_lines(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/lanes/host_lane.rs"));
    let text: String = lines.into_iter().map(|(_, l)| l + "\n").collect();
    assert!(text.contains("T::from_xdr(bytes, DECODE_LIMITS)"));
    assert!(text.contains("Limited::new(Cursor::new(bytes), DECODE_LIMITS)"));
    assert!(text.contains("depth: 500"));
}
