# @signet/spec — stable JSON serialisation

`ContractSpec` holds XDR objects and a `contract.Spec` instance, so it cannot
cross a process boundary. The API (`/api/v1`), the Go CLI, the Postgres cache
and React server-to-client props all need one versioned, deterministic JSON
form: `SpecJson`, defined in [`./src/json.ts`](./src/json.ts) and validated by
[`./schema/spec-json.v1.schema.json`](./schema/spec-json.v1.schema.json).

## API surface

All three functions live in [`./src/json.ts`](./src/json.ts) and are
re-exported from [`./src/index.ts`](./src/index.ts):

- `toSpecJson(spec, options?)` — serialises a [`ContractSpec`](./src/types.ts)
  to `SpecJson`. `entriesXdr` carries every entry's canonical XDR bytes as
  base64, in decode order; it is the source of truth. The flattened views
  (`functions`, `types`, `errors`, `events`) are copied field-by-field, never
  aliased, with `doc` presence preserved (absent stays absent) so a round-trip
  deep-equals. Optional extraction notes go in `options.warnings`.
- `fromSpecJson(json)` — rebuilds `entries` and `spec` from `entriesXdr` and
  copies the flattened views verbatim (it does not recompute them). Throws on
  a foreign `schemaVersion`; undecodable entries propagate the SDK's XDR
  error.
- `canonicalStringify(json)` — object keys sorted recursively (arrays keep
  their order — entry and input order is semantic). Byte-identical across runs
  and key-insertion orders, so `sha256(canonicalStringify(json))` is a stable
  ETag for the API, the CLI and the Postgres cache to agree on.

## Failure taxonomy

Extraction and decoding failures use the hierarchy in
[`./src/errors.ts`](./src/errors.ts): `ContractNotFound`, `NoInterface`
(`no_section` | `stellar_asset_contract` | `empty_section`),
`InterfaceUnreadable`, `RpcUnavailable` and `InvalidWasm`, unified under
`isSpecReadError`. The JSON layer itself fails in exactly two ways, both
thrown by `fromSpecJson`: a `schemaVersion` this reader does not handle, and
an `entriesXdr` element the SDK cannot decode.

## Cache model

Cache entries are keyed by WASM hash, as [`./src/cache/types.ts`](./src/cache/types.ts)
specifies: a hash's extracted spec is immutable, so entries are only ever
evicted for space, never invalidated for staleness. What is stored is the
`SpecJson` form (or, equivalently, its `canonicalStringify` bytes plus the
hash used as ETag) — never the live `ContractSpec`, whose XDR objects must
not be shared across cache readers.

## Browser-safe vs `/fetch` entry points

[`./src/json.ts`](./src/json.ts) has no `node:` imports, no `fetch` and no
filesystem access: it runs in browsers, workers and server runtimes alike.
Readers that fetch — over Horizon, Soroban RPC or the local filesystem —
live outside this module and convert at the boundary through `toSpecJson` /
`fromSpecJson` (see the Horizon fallback in `apps/web`, or the [Signet
CLI](../../docs/CLI.md) for a terminal-native reader). Keep it that way: a
network or filesystem import in `json.ts` would silently unship every browser
consumer.

## `schemaVersion` bump policy

- Additive fields (new optional members, new `TypeRef` arms surfaced under
  the existing `unknown` fallback) keep **v1**: old readers ignore what they
  do not know, and the schema gains the new optional member.
- Renames and removals need **v2**: a new `schemaVersion` const, a new
  `spec-json.v2.schema.json` next to (never replacing) v1, and a versioned
  reader. `fromSpecJson` rejects anything but the version it handles rather
  than coercing.
