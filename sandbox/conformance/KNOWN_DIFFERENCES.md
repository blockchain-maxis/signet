# Known differences between the host and the shared spec reader

The conformance suite (#547) holds the simulator's `spec_extract` and
`spec_encode_args` to the shared TS reader in `packages/spec`: the same
SpecJson, and the same `ScVal` bytes and verdict for every argument value in
`corpus.json`. A difference listed here is skipped by
`sandbox/simulator/tests/conformance.rs`, and must be justified line by line.
Anything not listed fails CI.

- `sdkVersion` (SpecJson): each side names the decoder that read the spec, not
  the contract. The TS reader records the `@stellar/stellar-sdk` version it
  decoded with (`16.1.0`); the host records its XDR crate
  (`signet-simulator/stellar-xdr@28.0.0`). Both are provenance of the reading,
  and they differ by design.

No argument encoding differs: every value in the corpus encodes to the same
bytes, and every refusal is a refusal on both sides.
