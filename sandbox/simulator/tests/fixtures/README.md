# Simulator test fixtures

Real Stellar testnet recordings, never edited by hand. Four of the five are
copied verbatim from
[`packages/fixtures/data/`](../../../../packages/fixtures/data): the table names
the file each one is a copy of, and one of them has another name there.
`network-config-entries.json` was captured directly from
`https://soroban-testnet.stellar.org`. Each file records its own provenance: the RPC URL, the request, and
`capturedAt`. `tests/xdr_helpers.rs` decodes them against the simulator binary, and
`tests/simulate.rs` serves them as Go would answer `ledger_fetch`.

| File                           | Copy of, in `packages/fixtures/data/` | What it is                                                                                                                                                                                                                            | Used to check                                                                                                                        |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `registry-instance-entry.json` | `registry-instance-entry.json`        | `getLedgerEntries` for the Identity Registry `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`'s instance entry. `request.params.keys[0]` is the key the capture asked RPC for, the same one `stellar contract read` builds. | `xdr_keys` builds byte-for-byte the same instance key, and the code key for the WASM hash the entry points at.                       |
| `claim-get-transaction.json`   | `claim-get-transaction.json`          | `getTransaction` for a real `claim` on that registry (tx `ce05dc2a…`), with `TransactionMeta` v4.                                                                                                                                     | `tx_decode` reads `claim(handle, wallet)`, its auth, and the on-chain return value and `claimed` event out of the envelope and meta. |
| `deploy-get-transaction.json`  | `deploy-get-transaction.json`         | `getTransaction` for a real create-contract deployment.                                                                                                                                                                               | `tx_decode` reports a non-`InvokeContract` host function as `replayable: false` with a reason, and still reads its return value.     |
| `registry-code-entry.json`     | `contract-wasm-entry.json`, renamed   | `getLedgerEntries` for the registry's executable (hash `936996c7…`), the code entry its instance points at.                                                                                                                           | `simulate` on a fork of the registry fetches it, with the instance, on the first call and never again.                               |
| `network-config-entries.json`  | Nothing: captured here                | `getLedgerEntries` for the ten `ConfigSetting` entries `NetworkConfig::load_from_snapshot` reads (keys from `xdr_keys` `network_config`), captured 2026-10-24 while testnet ran protocol 29.                                          | The fee and resource numbers `simulate` reports come from real network config, not constants.                                        |

To refresh, re-run the capture and copy the four files here again, giving the
registry's code entry its name in this directory:

```bash
pnpm --filter @signet/fixtures capture
cp packages/fixtures/data/registry-instance-entry.json sandbox/simulator/tests/fixtures/
cp packages/fixtures/data/claim-get-transaction.json sandbox/simulator/tests/fixtures/
cp packages/fixtures/data/deploy-get-transaction.json sandbox/simulator/tests/fixtures/
cp packages/fixtures/data/contract-wasm-entry.json sandbox/simulator/tests/fixtures/registry-code-entry.json
```

Then update the expectations in `tests/xdr_helpers.rs` if a newer claim was
recorded. `network-config-entries.json` is not part of that capture.
