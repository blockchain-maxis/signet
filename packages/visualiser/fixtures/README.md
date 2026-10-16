# Visualiser spec fixtures

Real contract specs, captured once and committed, so that no test touches the
network (#483). They are test fixtures only and never appear in the product.

Each `<name>.spec.json` holds:

```json
{
  "network": "testnet | mainnet",
  "address": "C...",
  "wasmHash": "<hex sha-256 of the deployed WASM>",
  "capturedAtLedger": 0,
  "entriesXdrBase64": ["<one ScSpecEntry per item, base64 XDR>"]
}
```

`src/load-fixture.ts` exports `loadFixture(name): ContractSpec`. It decodes the
entries, builds the flattened views with `@signet/spec`'s `buildSpecViews` and
`buildEvents`, and rebuilds the spec through `fromSpecJson`. The WASM is not
stored, so these specs carry no `build` or `env` meta.

## Fixtures

| Fixture             | Network | Address                                                    | Ledger   | WASM hash                                                          |
| ------------------- | ------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `identity-registry` | testnet | `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN` | 5042836  | `936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe` |
| `soroswap-router`   | mainnet | `CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH` | 64790398 | `4c3db3ebd2d6a2ab23de1f622eaabb39501539b4611b68622ec4e47f76c4ba07` |
| `blend-pool-v1`     | mainnet | `CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP` | 64790462 | `baf978f10efdbcd85747868bef8832845ea6809f7643b67a4ac0cd669327fc2c` |
| `axelar-its`        | mainnet | `CBDBMIOFHGWUFRYH3D3STI2DHBOWGDDBCRKQEUB4RGQEBVG74SEED6C6` | 64973281 | `27b2ef8c7288da0bf5cd997cb7ca02c71163b339c76c496ed7985994b25019a7` |

`capturedAtLedger` is the RPC endpoint's latest ledger read just after the
spec was fetched, so it is an upper bound on the state that was read. A
contract's spec is fixed by its WASM, so the hash is what identifies it.

| Fixture             | Functions | Structs            | Unions | Error enums  | Size  |
| ------------------- | --------- | ------------------ | ------ | ------------ | ----- |
| `identity-registry` | 8         | 0                  | 0      | 1 (7 cases)  | 4 KB  |
| `soroswap-router`   | 20        | 4 (event payloads) | 0      | 3            | 24 KB |
| `blend-pool-v1`     | 18        | 16                 | 2      | 1            | 16 KB |
| `axelar-its`        | 49        | 9                  | 2      | 1 (71 cases) | 15 KB |

## Provenance and licence

| Fixture             | Source                                                                                                                                              | Licence                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `identity-registry` | this repository, `packages/contracts/identity-registry`                                                                                             | Apache-2.0, [`LICENSE`](../../../LICENSE)                                                         |
| `soroswap-router`   | <https://github.com/soroswap/core> (`contracts/router`)                                                                                             | Apache-2.0, <https://github.com/soroswap/core/blob/main/LICENSE>                                  |
| `blend-pool-v1`     | <https://github.com/blend-capital/blend-contracts> (lending pool)                                                                                   | AGPL-3.0, <https://github.com/blend-capital/blend-contracts/blob/main/LICENSE>                    |
| `axelar-its`        | <https://github.com/axelarnetwork/axelar-cgp-stellar> (`contracts/stellar-interchain-token-service`, tag `stellar-interchain-token-service-v2.1.1`) | Apache-2.0 or MIT, <https://github.com/axelarnetwork/axelar-cgp-stellar/blob/main/LICENSE-APACHE> |

How each address and source were tied together:

- `identity-registry`: the address is the deployment documented in
  `docs/REGISTRY_INTEGRATION.md`; its hash equals the one in
  `packages/spec/fixtures/manifest.json`.
- `soroswap-router`: the address and the router hash `4c3db3eb...` are listed in
  Soroswap's `public/mainnet.contracts.json`; the captured hash matches it.
- `blend-pool-v1`: the address is the `Fixed` pool in blend-capital's
  `blend-utils` `mainnet.contracts.json`, whose `lendingPool` hash
  (`baf978f1...`) matches the captured one. That is the v1 lending pool, built
  from `blend-contracts`.
- `axelar-its`: the Interchain Token Service on Stellar mainnet, the 40+
  function contract the issue asks for (49 functions). Axelar's deployment
  config (`axelar-contract-deployments`, `axelar-chains-config/info/mainnet.json`)
  gives the address but still lists the 1.1.1 hash, so the contract has been
  upgraded since. The deployed contract's `version()` returns `2.1.1`, and the
  deployed wasm carries no `source_repo` / `source_rev`, so the hash had to be
  tied to source by rebuilding it: tag `stellar-interchain-token-service-v2.1.1`
  (commit `0c518ddfaa0678276aa6364221305c45087e6ba8`) built with the repo's
  own release recipe (Rust 1.89.0, Stellar CLI 25.2.0,
  `stellar contract build --optimize --package stellar-interchain-token-service`)
  hashes to `27b2ef8c...19a7`, byte for byte the deployed hash.
  Its spec references two SDK-generated types it does not define
  (`__InterchainTokenServiceMigrationData` and
  `__InterchainTokenServiceAxelarExecutableInterfaceError`); `stellar contract
build` warns about the same two. The tests list them as the expected
  undefined types for this fixture.

The Blend fixture is a spec, which is interface data (names and types), not the
AGPL-3.0 source. The licence is recorded so it can be reviewed; drop the
fixture if the project decides AGPL-derived data does not belong here.

## Recapturing

Run by hand only, never in CI. It needs network access to a Soroban RPC
endpoint:

```sh
cd packages/visualiser
node --experimental-strip-types scripts/capture-fixture.mts <address> <network> <name> [rpcUrl]
```

The default endpoints are `https://soroban-testnet.stellar.org` and
`https://mainnet.sorobanrpc.com`. Add the new row, source and licence here: a
test checks that every fixture's address, network, ledger and hash appear in
this file. Only capture a contract whose source and licence you have
confirmed.
