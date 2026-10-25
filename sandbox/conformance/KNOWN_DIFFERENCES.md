# Known differences between the host and the shared spec reader

The conformance suite (#547) holds the simulator's `spec_extract`,
`spec_encode_args` and `spec_diff` to the shared TS reader in `packages/spec`: the same
SpecJson, and the same `ScVal` bytes and verdict for every argument value in
`corpus.json`. A difference listed here is skipped by
`sandbox/simulator/tests/conformance.rs`, and must be justified line by line.
Anything not listed fails CI.

- `sdkVersion` (SpecJson): each side names the decoder that read the spec, not
  the contract. The TS reader records the `@stellar/stellar-sdk` version it
  decoded with (`16.1.0`); the host records its XDR crate
  (`signet-simulator/stellar-xdr@28.0.0`). Both are provenance of the reading,
  and they differ by design.

- `cap86-sparse-option` (`spec_diff`, #570): a struct field added is
  breaking in the reader's `diffSpecs`, which sees the interface only. The
  host also reads the new build's imports: when it decodes structs through
  CAP-86's sparse unpack (`sparse_map_unpack_to_linear_memory`, which
  soroban-sdk 28 builds import) and the new field is an `Option`, a value
  stored without the field still decodes, with the field `None`. The host
  calls that change compatible, under this rule, and says so on the change.
  Every other change agrees on breaking vs compatible.

No argument encoding differs: every value in the corpus encodes to the same
bytes, and every refusal is a refusal on both sides.
