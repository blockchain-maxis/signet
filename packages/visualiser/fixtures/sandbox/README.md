# Sandbox trace fixtures

Call traces (`sandbox/protocol/schema/v1/trace.json`, version 1) that
`src/observe/sandbox.ts` reads (#542). They are test fixtures only.

| Fixture                     | Call                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| `registry-count.trace.json` | `count` on the testnet identity registry                                |
| `registry-claim.trace.json` | `claim` with handle `trace-fixture` and wallet `GA5Z…ZVN`, as a dry run |

Both are real `signet-simulator` output (#541), not written by hand: the
registry `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN` forked at
testnet ledger 4887004, every entry served from the simulator's recorded
`getLedgerEntries` responses in `sandbox/simulator/tests/fixtures/`, so no
network was involved and the run is unseeded. They were not produced through
`signet sandbox call`, which has no trace flag yet; when it has one, they
should be recaptured through it.

Recapture after building the simulator (`cargo build` in `sandbox/`):

```sh
node --experimental-strip-types scripts/capture-sandbox-traces.mts
```

The caller → callee test uses the traced `simulate` in
`sandbox/protocol/transcripts/trace.ndjson`, run on the `caller` and `callee`
fixture contracts.
