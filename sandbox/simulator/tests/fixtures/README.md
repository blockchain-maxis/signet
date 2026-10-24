# Simulator test fixtures

Real Stellar testnet recordings, copied verbatim from
[`packages/fixtures/data/`](../../../../packages/fixtures/data) and never edited by
hand. Each file records its own provenance: the RPC URL, the request, and
`capturedAt`. `tests/xdr_helpers.rs` decodes them against the simulator binary.

| File                           | What it is                                                                                                                                                                                                                            | Used to check                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `registry-instance-entry.json` | `getLedgerEntries` for the Identity Registry `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`'s instance entry. `request.params.keys[0]` is the key the capture asked RPC for, the same one `stellar contract read` builds. | `xdr_keys` builds byte-for-byte the same instance key, and the code key for the WASM hash the entry points at.                       |
| `claim-get-transaction.json`   | `getTransaction` for a real `claim` on that registry (tx `ce05dc2a…`), with `TransactionMeta` v4.                                                                                                                                     | `tx_decode` reads `claim(handle, wallet)`, its auth, and the on-chain return value and `claimed` event out of the envelope and meta. |
| `deploy-get-transaction.json`  | `getTransaction` for a real create-contract deployment.                                                                                                                                                                               | `tx_decode` reports a non-`InvokeContract` host function as `replayable: false` with a reason, and still reads its return value.     |

To refresh, re-run `pnpm --filter @signet/fixtures capture`, copy the three files
here again, and update the expectations in `tests/xdr_helpers.rs` if a newer
claim was recorded.
