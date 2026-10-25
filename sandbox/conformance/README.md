# Spec reader conformance

There is one spec reader, `packages/spec`. The simulator has to read a
contract's spec to run it, so its reading is pinned to that reader here
(#547): if the two ever disagree, CI fails rather than the UI and the
terminal quietly accepting different inputs.

- `generate.mts` builds `corpus.json` from the shared reader: for every fixture
  WASM (`packages/spec/fixtures`, and the sandbox fixtures in
  `sandbox/fixtures/wasm`), its SpecJson
  (`canonicalStringify(toSpecJson(parseContractSpec(wasm)))`), and, per
  function, JSON argument values in `functionArgsSchema`'s shape, valid and
  invalid, with the `ScVal` XDR the reader's encoder (the SDK's
  `contract.Spec`) produces or its refusal.
- `sandbox/simulator/tests/conformance.rs` replays the corpus through the
  host's `spec_extract` and `spec_encode_args` and fails on any difference,
  printing the value and both encodings.
- `KNOWN_DIFFERENCES.md` lists, and justifies, what the test skips.

After changing the reader or adding a fixture:

```sh
node --experimental-strip-types sandbox/conformance/generate.mts
cargo test --manifest-path sandbox/Cargo.toml --test conformance
```

CI runs `generate.mts --check` (the corpus is the reader's current output)
and the Rust test in the sandbox job.
