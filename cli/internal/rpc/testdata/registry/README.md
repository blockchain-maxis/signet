# Registry RPC fixtures

What a Stellar RPC answers about the testnet Identity Registry
(`CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`), for the
`signet sandbox` tests in `internal/cmd`. A test server answers each JSON-RPC
method with the file of the same name; `getLedgerEntries` returns only the
entries asked for.

- `getLedgerEntries.json` holds real recordings, unedited: the registry's
  instance and code entries (captured at ledger 4887004, the same files as
  `sandbox/simulator/tests/fixtures/registry-*-entry.json`) and testnet's ten
  network `ConfigSetting` entries (`network-config-entries.json` there,
  captured 2026-10-24).
- `getNetwork.json` and `getLatestLedger.json` are composed to match: testnet's
  passphrase, the ledger the registry was captured at, and protocol 28, the
  older of the two lanes the simulator runs. `getLatestLedger`'s `id` is a placeholder and its
  `closeTime` the capture's `latestLedgerCloseTime`.

- `calls-getLedgerEntries.json` is not a recording: a pair of contracts where
  one calls the other (#552), the sandbox's `caller` and `callee` fixture WASMs
  with ids derived from fixed labels and entries dated before the fork ledger.
  `generate-calls.mjs` writes it; the test server answers `getLedgerEntries`
  from it as well as from the recordings.

- `snapshot.json` is a `stellar snapshot create` file (soroban-ledger-snapshot's
  `LedgerSnapshot` JSON) of the same entries: the recorded `getLedgerEntries`
  answers above, each decoded with `stellar xdr decode --type LedgerEntryData`
  into the serde JSON `stellar snapshot create` writes, at the registry's
  ledger, with testnet's network id and the TTL minimums of the recorded
  `StateArchival` setting. It was composed rather than taken from a history
  archive (#554 asks for a local Quickstart, which was not available); the
  simulator's own test checks that reading it gives back the recorded entries
  byte for byte.
