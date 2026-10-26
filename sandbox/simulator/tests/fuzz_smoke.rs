//! The fuzz targets' entry points on stable (#525): every seed in the corpus,
//! a few thousand cheap mutations of them, and the regressions the targets
//! found. `cargo +nightly fuzz run <target>` (sandbox/fuzz) explores far
//! more; this keeps the targets compiling and the known crashes fixed on
//! every `cargo test`.

use std::path::PathBuf;

use signet_simulator::fuzzing;

fn corpus(target: &str) -> Vec<Vec<u8>> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../fuzz/corpus")
        .join(target);
    let mut seeds: Vec<Vec<u8>> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|entry| std::fs::read(entry.unwrap().path()).unwrap())
        .collect();
    assert!(!seeds.is_empty(), "no seeds in {}", dir.display());
    seeds.sort();
    seeds
}

/// xorshift: deterministic, so a failure here reproduces.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Flip, insert, delete and splice bytes, as libFuzzer's simplest mutators do.
fn mutate(rng: &mut Rng, seed: &[u8], seeds: &[Vec<u8>]) -> Vec<u8> {
    let mut out = seed.to_vec();
    for _ in 0..1 + rng.below(4) {
        match rng.below(5) {
            0 if !out.is_empty() => {
                let i = rng.below(out.len());
                out[i] ^= 1 << rng.below(8);
            }
            1 => {
                let i = rng.below(out.len() + 1);
                out.insert(i, rng.next() as u8);
            }
            2 if !out.is_empty() => {
                let i = rng.below(out.len());
                out.remove(i);
            }
            3 if !out.is_empty() => {
                let i = rng.below(out.len());
                out[i] = [b'{', b'}', b'"', b'\n', 0, 0xff, b'['][rng.below(7)];
            }
            _ => {
                let other = &seeds[rng.below(seeds.len())];
                let cut = rng.below(out.len() + 1);
                let from = rng.below(other.len() + 1);
                out.truncate(cut);
                out.extend_from_slice(&other[from..]);
            }
        }
    }
    out
}

fn run(target: &str, f: fn(&[u8]), mutations: usize) {
    let seeds = corpus(target);
    for seed in &seeds {
        f(seed);
    }
    let mut rng = Rng(0x5eed_0000_0000_0001 ^ target.len() as u64);
    for _ in 0..mutations {
        let seed = &seeds[rng.below(seeds.len())];
        f(&mutate(&mut rng, seed, &seeds));
    }
}

#[test]
fn framing_survives_its_corpus_and_mutations() {
    run("framing", fuzzing::framing, 5_000);
}

#[test]
fn dispatch_survives_its_corpus_and_mutations() {
    run("dispatch", fuzzing::dispatch, 1_500);
}

#[test]
fn xdr_params_survive_their_corpus_and_mutations() {
    run("xdr_params", fuzzing::xdr_params, 300);
}

/// `SCV_VEC` (16), present, one element, nested `depth` times around a void.
fn nested_vec(depth: usize) -> Vec<u8> {
    let mut xdr = Vec::with_capacity(depth * 12 + 4);
    for _ in 0..depth {
        xdr.extend_from_slice(&16u32.to_be_bytes());
        xdr.extend_from_slice(&1u32.to_be_bytes());
        xdr.extend_from_slice(&1u32.to_be_bytes());
    }
    xdr.extend_from_slice(&1u32.to_be_bytes()); // SCV_VOID
    xdr
}

/// Found by `xdr_params`: XDR was decoded with `Limits::none()`, so an `ScVal`
/// nested a hundred thousand deep recursed until the stack overflowed and
/// killed the process. Decoding now stops at the depth limit with an error.
#[test]
fn deeply_nested_xdr_is_an_error_not_a_stack_overflow() {
    for lane in [0u8, 1] {
        let mut input = vec![lane];
        input.extend(nested_vec(100_000));
        fuzzing::xdr_params(&input);
    }
}
