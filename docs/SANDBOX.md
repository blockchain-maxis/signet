# The contract sandbox

`signet sandbox` runs a deployed contract's functions locally, against a fork
of the network, without submitting anything. The commands are in
[`cli/README.md`](../cli/README.md#signet-sandbox-fork); the design is in
[`CONTRACT_SANDBOX_DESIGN.md`](CONTRACT_SANDBOX_DESIGN.md), and the CLI ↔
simulator protocol in [`CLI_RUST_BRIDGE.md`](CLI_RUST_BRIDGE.md).

## `signet.dev.toml`

Saved calls, replay settings, diff rules and storage overrides live in a
`signet.dev.toml` committed with the contract, so a teammate or CI runs the
same checks (#560). The CLI reads it strictly: a key the schema does not have
is an error naming its line, so a typo never silently turns a check off.

```toml
version = 1
network = "testnet"          # or a [network] table with rpc_url and passphrase
address = "CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN"
path = "./contracts/registry"   # the crate directory; package = "identity-registry" in a workspace

[replay]
saved = true                 # replay the [[call]]s below
recent_transactions = 20     # and the contract's last 20 transactions; 0 disables
include_failed = false

[[call]]
name = "count is stable"
function = "count"
args = {}
expect = "unchanged"         # unchanged | ok | error:<Name> | any

[[call]]
name = "a taken handle is refused"
function = "claim"
args = { handle = "alice", wallet = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }
expect = "error:HandleTaken"

[[override]]
durability = "persistent"
key = 'Owner("alice")'
value = '"GC6YINA5FD5MLUI4LKC4JYI5AKAW7BRFJRKNEU3TVRZWYNYN3KKZJR3G"'

[diff]
ignore_events = []           # event topic prefixes a diff leaves out
resource_tolerance = { instructions = "10%", fee = "10%" }
```

- `version` is `1`, the only version there is.
- `network` names a network (`testnet`, `mainnet`), or is a table with
  `rpc_url` and `passphrase` for any other.
- `address` is the deployed contract (`C…`); `path` (and `package`) the crate
  it is built from.
- A `[[call]]` has a unique `name`, a `function`, its `args` as JSON-shaped
  TOML in the contract's argument encoding (the same as `--arg`), and what it
  should do: `unchanged` (the same result as the last time it ran), `ok`,
  `error:<Name>` (that contract error), or `any`. Against the deployed
  contract, each function must exist, its arguments must encode, and an
  expected error must be one the contract declares.
- An `[[override]]` is a storage override, as `--set-storage` takes:
  `durability` (`instance`, `persistent` or `temporary`), `key`, and `value` or
  `unset = true`.
- `[diff]` leaves out events by topic prefix and tolerates resource changes up
  to a percentage, for `instructions`, `read_bytes`, `write_bytes` and `fee`.

Editors with [Taplo](https://taplo.tamasfe.dev) can validate the file against
[`sandbox/protocol/schema/v1/signet-dev-toml.json`](../sandbox/protocol/schema/v1/signet-dev-toml.json);
the CLI's tests hold this page's example to that schema.

## Archive forks

A lazy fork knows only the keys something has read and can mix ledgers.
`signet sandbox fork <C…> --archive` instead imports every entry of the
contract at a history-archive checkpoint through `stellar snapshot create`
(#554). It is slow: when this was planned, `stellar snapshot create` on testnet
ran for 3 minutes 27 seconds before a bucket download failed. A failed snapshot
is retried once; after that the lazy fork, which needs no archive, is the way
on.
