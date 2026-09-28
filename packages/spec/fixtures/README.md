# Contract WASM Fixtures

This directory contains deployed WASM bytecode fixtures captured from the live Stellar network (testnet).

These are **exact deployed bytes** fetched from the network, not local `cargo build` artifacts (which vary across compilers and local toolchains). Every test assertion in `@signet/spec` is verified against these on-chain bytes.

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
