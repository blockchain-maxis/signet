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

`signet dev init <contract> [--path ./contract]` writes a commented
`signet.dev.toml` in the current directory to start from, with one saved call
per read-only function: a function that takes no arguments and, run on a fork,
wrote nothing. It never guesses arguments for the others, and keeps an
existing file unless `--force`.

The quickest way to build the suite is to explore with `signet sandbox call`
and keep what is worth keeping: `--save` appends the call as a `[[call]]`
(named after its function, or `--save="a name"`), with its arguments as they
were parsed and `expect = "unchanged"`. It finds `signet.dev.toml` by walking
up from the working directory, writes nothing when there is none, and only
appends: what is already in the file, comments included, stays as it was.

Editors with [Taplo](https://taplo.tamasfe.dev) can validate the file against
[`sandbox/protocol/schema/v1/signet-dev-toml.json`](../sandbox/protocol/schema/v1/signet-dev-toml.json);
the CLI's tests hold this page's example to that schema.

## `signet dev`

`signet dev <contract> --path ./contract` is the development loop: it builds
the local contract, runs its saved calls on the deployed and the new code from
the same forked state, and compares them, every time the source changes. The
contract, `--path` and `--package` come from the flags, or for what they leave
out from the nearest `signet.dev.toml`.

Before anything starts it checks the toolchain, in this order, and stops at the
first missing piece with what to do about it:

1. the `stellar` CLI, at least the version signet needs;
2. `cargo`;
3. the `wasm32v1-none` Rust target (`rustup target add wasm32v1-none`);
4. a contract crate at `--path`: a `Cargo.toml` with a `cdylib` crate (and,
   in a workspace with several, the one `--package` names);
5. the `signet-simulator`;
6. a simulator lane for the network's ledger protocol.

The first five exit `3`; a protocol no lane runs exits `11`. Then it forks the
contract and prints what it runs against:

```text
signet dev · CASF…RCN @ testnet ledger 4852095 · lane p28 · crate identity-registry
```

## Archive forks

A lazy fork knows only the keys something has read and can mix ledgers.
`signet sandbox fork <C…> --archive` instead imports every entry of the
contract at a history-archive checkpoint through `stellar snapshot create`
(#554). It is slow: when this was planned, `stellar snapshot create` on testnet
ran for 3 minutes 27 seconds before a bucket download failed. A failed snapshot
is retried once; after that the lazy fork, which needs no archive, is the way
on.
