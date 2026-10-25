// The lanes manifest check (#591), shared by build.rs and the crate's tests:
// sandbox/simulator/lanes.toml against the workspace's pins and the crate's
// lane features. Hand-parsed: both files are this repository's own, in a
// fixed shape, and a build script should not grow a TOML dependency.

/// One lane of lanes.toml.
#[derive(Debug, PartialEq, Eq)]
pub struct Lane {
    pub protocol: u32,
    pub env_host: String,
    pub simulation: String,
}

fn unquote(v: &str) -> String {
    v.trim().trim_matches('"').to_string()
}

/// The lanes of a lanes.toml.
pub fn parse_lanes(text: &str) -> Result<Vec<Lane>, String> {
    type Partial = (Option<u32>, Option<String>, Option<String>);
    fn finish(c: Option<Partial>, lanes: &mut Vec<Lane>) -> Result<(), String> {
        if let Some((p, h, s)) = c {
            lanes.push(Lane {
                protocol: p.ok_or("a [[lane]] without protocol")?,
                env_host: h.ok_or("a [[lane]] without soroban-env-host")?,
                simulation: s.ok_or("a [[lane]] without soroban-simulation")?,
            });
        }
        Ok(())
    }
    let mut lanes = Vec::new();
    let mut current: Option<Partial> = None;
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line == "[[lane]]" {
            finish(current.take(), &mut lanes)?;
            current = Some((None, None, None));
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Err(format!("lanes.toml: cannot read `{line}`"));
        };
        let Some(c) = current.as_mut() else {
            return Err(format!("lanes.toml: `{line}` is outside a [[lane]]"));
        };
        match key.trim() {
            "protocol" => c.0 = Some(value.trim().parse().map_err(|_| format!("lanes.toml: protocol `{}` is not a number", value.trim()))?),
            "soroban-env-host" => c.1 = Some(unquote(value)),
            "soroban-simulation" => c.2 = Some(unquote(value)),
            other => return Err(format!("lanes.toml: unknown key `{other}`")),
        }
    }
    finish(current, &mut lanes)?;
    if lanes.is_empty() {
        return Err("lanes.toml lists no lanes".into());
    }
    Ok(lanes)
}

/// The exact version a workspace dependency line pins: `name = { …, version = "=X", … }`.
fn pinned(cargo: &str, name: &str) -> Option<String> {
    let line = cargo.lines().find(|l| l.trim_start().starts_with(&format!("{name} =")))?;
    let at = line.find("version")?;
    let rest = &line[at..];
    let open = rest.find('"')? + 1;
    let close = rest[open..].find('"')? + open;
    Some(rest[open..close].trim_start_matches('=').to_string())
}

/// Checks the workspace pins (`sandbox/Cargo.toml`) and the crate's
/// features (`sandbox/simulator/Cargo.toml`) against the lanes.
pub fn check(lanes: &[Lane], workspace: &str, crate_toml: &str) -> Result<(), String> {
    for lane in lanes {
        let p = lane.protocol;
        for (dep, want) in [("soroban-env-host", &lane.env_host), ("soroban-simulation", &lane.simulation)] {
            let name = format!("{dep}-p{p}");
            match pinned(workspace, &name) {
                Some(got) if &got == want => {}
                Some(got) => return Err(format!("lanes.toml says protocol {p} links {dep} {want}, but sandbox/Cargo.toml pins {name} to ={got}")),
                None => return Err(format!("lanes.toml lists protocol {p}, but sandbox/Cargo.toml has no {name} pin")),
            }
        }
        if !crate_toml.lines().any(|l| l.trim_start().starts_with(&format!("lane-p{p} ="))) {
            return Err(format!("lanes.toml lists protocol {p}, but signet-simulator has no lane-p{p} feature"));
        }
    }
    Ok(())
}
