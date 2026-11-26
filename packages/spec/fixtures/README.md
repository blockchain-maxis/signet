# Contract WASM Fixtures

This directory contains deployed WASM bytecode fixtures captured from the live Stellar network (testnet).

These are **exact deployed bytes** fetched from the network, not local `cargo build` artifacts (which vary across compilers and local toolchains). Every test assertion in `@signet/spec` is verified against these on-chain bytes.

## Locally-built fixtures

Alongside the network captures, this directory holds fixtures built from
source in [`../fixture-contracts/`](../fixture-contracts/) (Backlog ID `B-04`).
These exist so the reader is exercised on spec shapes the registry never
publishes (every type arm, undocumented functions, events, multiple error
sets) and on unhappy paths (no spec section, truncated spec section):

| Fixture | Covers |
|---|---|
| `types_zoo.wasm` | Every `ScSpecTypeDef` arm: integers `u32`–`i256`, `bool`, `symbol`/`string`/`bytes`/`bytes_n`, `address`, `timepoint`/`duration`, `option`/`result`/`vec`/`map`/`tuple`, a struct nested three levels deep, a unit enum, a tuple enum (union arm), an error enum, and a `void` function |
| `undocumented.wasm` | Functions with no doc comments |
| `events.wasm` | `#[contractevent]` types with topics and data |
| `errors_multi.wasm` | Two `#[contracterror]` enums in one spec |
| `upgrade_v1.wasm` | Baseline of a real two-version contract upgrade |
| `upgrade_v2.wasm` | Upgrade with function, argument, type, error, event, and doc changes |
| `no_spec.wasm` | A module with no `contractspecv0` section, from hand-written WAT |
| `corrupt_section.wasm` | The registry fixture's `contractspecv0` section truncated mid-entry |

Unlike the network captures, these bytes ARE local build artifacts — but
reproducible ones: the fixture workspace pins its Rust toolchain
(`fixture-contracts/rust-toolchain.toml`), its dependencies (committed
`Cargo.lock`), and its release profile, and `stellar contract optimize` is
deliberately never run (optimization would tie every fixture to the CLI
version that ran it; the committed bytes are exactly what the SDK emitted).
The `spec-fixtures` CI job rebuilds all eight from source and fails on any
byte difference, so no fixture is ever a hand-edited binary.

## Manifest

Provenance for each fixture is recorded in [`manifest.json`](./manifest.json):
- `file`: WASM filename in `fixtures/`
- `sourceContract`: On-chain contract address (`C...`)
- `network`: Network passphrase / identifier (`testnet`)
- `wasmHash`: SHA-256 hash of the bytecode
- `bytes`: Exact byte length
- `fetchedAt`: ISO-8601 timestamp when fetched

## Refreshing Fixtures

To refresh or capture a new fixture from the network:

```bash
# In packages/spec
node --experimental-strip-types scripts/fetch-fixture.ts <CONTRACT_ADDRESS> <FIXTURE_NAME>
```

Example for the Identity Registry:
```bash
node --experimental-strip-types scripts/fetch-fixture.ts CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN identity-registry
```

## Rebuilding the local fixtures

Prerequisites: a Rust toolchain honouring
[`../fixture-contracts/rust-toolchain.toml`](../fixture-contracts/rust-toolchain.toml),
`stellar-cli` (only `contract build` is used), `wabt` (`wat2wasm`), and node.

```bash
# Rebuild and refresh the eight committed WASMs in place:
bash ../fixture-contracts/build-fixtures.sh

# Verify without writing (what CI runs):
bash ../fixture-contracts/build-fixtures.sh --check
```
