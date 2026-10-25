//! The lanes manifest (#591): lanes.toml is the single source of truth, and
//! build.rs refuses a build whose pins disagree with it. These run the same
//! check build.rs runs, on the real files and on broken copies.

include!("../build/lanes_check.rs");

fn files() -> (String, String, String) {
    let read = |p: &str| {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/").to_string() + p).unwrap()
    };
    (
        read("lanes.toml"),
        read("../Cargo.toml"),
        read("Cargo.toml"),
    )
}

#[test]
fn the_manifest_agrees_with_the_pins() {
    let (lanes, workspace, krate) = files();
    let lanes = parse_lanes(&lanes).unwrap();
    assert_eq!(
        lanes.iter().map(|l| l.protocol).collect::<Vec<_>>(),
        [28, 29]
    );
    check(&lanes, &workspace, &krate).unwrap();
}

#[test]
fn a_pin_that_moved_without_the_manifest_fails_the_build() {
    let (lanes, workspace, krate) = files();
    let lanes = parse_lanes(&lanes).unwrap();
    let bumped = workspace.replace(
        r#"soroban-env-host-p29 = { package = "soroban-env-host", version = "=29.0.2""#,
        r#"soroban-env-host-p29 = { package = "soroban-env-host", version = "=29.0.3""#,
    );
    assert_ne!(bumped, workspace, "the fixture edit did not apply");
    let err = check(&lanes, &bumped, &krate).unwrap_err();
    assert_eq!(err, "lanes.toml says protocol 29 links soroban-env-host 29.0.2, but sandbox/Cargo.toml pins soroban-env-host-p29 to =29.0.3");
}

#[test]
fn a_lane_without_its_pins_or_feature_fails_the_build() {
    let (_, workspace, krate) = files();
    let lanes = parse_lanes(
        "[[lane]]\nprotocol = 30\nsoroban-env-host = \"30.0.0\"\nsoroban-simulation = \"30.0.0\"\n",
    )
    .unwrap();
    assert!(check(&lanes, &workspace, &krate)
        .unwrap_err()
        .contains("no soroban-env-host-p30 pin"));
    let pinned = format!("{workspace}\nsoroban-env-host-p30 = {{ package = \"soroban-env-host\", version = \"=30.0.0\" }}\nsoroban-simulation-p30 = {{ package = \"soroban-simulation\", version = \"=30.0.0\" }}\n");
    assert!(check(&lanes, &pinned, &krate)
        .unwrap_err()
        .contains("no lane-p30 feature"));
}

#[test]
fn a_malformed_manifest_is_refused() {
    assert!(parse_lanes("").unwrap_err().contains("no lanes"));
    assert!(parse_lanes("protocol = 28\n")
        .unwrap_err()
        .contains("outside a [[lane]]"));
    assert!(parse_lanes("[[lane]]\nprotocol = 28\n")
        .unwrap_err()
        .contains("without soroban-env-host"));
}
