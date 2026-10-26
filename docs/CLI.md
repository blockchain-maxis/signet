# Signet CLI

`signet` binds the wallet you deploy contracts from to your Signet handle, so
the contracts that wallet has deployed are attributed to you.

The contract sandbox, which runs deployed contracts locally and checks a new
build against them (`signet sandbox`, `signet dev`), is documented separately
in [`SANDBOX.md`](SANDBOX.md). In short:

```bash
signet dev init <contract> --path ./contract   # writes signet.dev.toml
signet dev <contract> --path ./contract        # rebuild, replay, diff on every save
```

It runs entirely on your machine; no Signet server executes contract code.

That binding is the thing the whole product rests on, so the CLI is deliberately
careful about what it proves and what it never touches. Two facts to hold onto
while reading the rest:

- **signet never reads your secret key.** Signing goes through your local
  `stellar` CLI (`stellar tx sign --sign-with-key`), which already owns key
  storage. signet passes it a transaction and gets a signed one back.
- **Linking takes two independent proofs.** Approving in the browser proves you
  own the handle. Signing a challenge proves you control the deploy key.
  Neither alone is enough, because accepting either on its own is exactly how
  someone would claim another developer's contracts.

## Install

```bash
npx @signet/cli link
```

`npx` fetches a small wrapper that installs the right prebuilt package for your
platform. Each package, and each per-platform archive on the GitHub Release
(`signet-<version>-<platform>.tar.gz`, or `.zip` for Windows), holds `signet`
and `signet-simulator` side by side, built from the same tag. Keep them in the
same directory if you unpack an archive by hand. To keep the CLI around:

```bash
npm install -g @signet/cli
signet --version
```

Building from source needs Go (see `cli/go.mod` for the version) and a stable
Rust toolchain for the simulator:

```bash
cd cli && go build ./cmd/signet
cargo build --release --locked --manifest-path sandbox/Cargo.toml -p signet-simulator
```

## Prerequisite: the `stellar` CLI

signet shells out to `stellar` for identity and signing, and refuses to run
without it rather than half-working:

```bash
stellar --version   # must be >= 25.2.0
```

25.2.0 is where `tx sign` gained `--sign-with-key` and reading the transaction
from stdin — the two things that let signet sign without ever holding the
secret. Install instructions:
<https://developers.stellar.org/docs/tools/cli/install-cli>.

## The link flow, and what each step proves

```bash
signet link
```

0. **Check the network.** signet reads the deployment's
   `GET /.well-known/stellar.toml` and compares its `NETWORK_PASSPHRASE` with
   the network the command resolved (`--network`, `SIGNET_NETWORK`, the
   context, or the default `testnet`). A deployment serves exactly one
   network, so a mismatch stops here with exit `3`, naming both networks and
   the fix — before an identity is resolved or a pairing is opened. A
   deployment that publishes no `stellar.toml` (a `404`) is not refused: the
   server still checks the network at `pair/start`. `signet unlink` runs the
   same check first. See [Network names and passphrases](#network-names-and-passphrases).
1. **Resolve the deploy identity.** `stellar keys ls` / `stellar keys address`
   turn your chosen identity into a public key. If you have exactly one
   identity it is used; if you have several you are asked which. *Proves
   nothing yet — it is just deciding which key the rest of the flow is about.*
2. **Mint a pairing.** signet calls `POST /api/cli/pair/start` with
   `{network, publicKey}`. The key is **required** — the server refuses a
   start without one, so an approval page can never show "key not declared" —
   but the declaration is **not** trusted; it exists so the browser can show
   you which key you are approving. The response includes a short
   **confirmation code**, which signet prints next to the approval URL and
   carries in that URL as `user_code`.
3. **Approve in the browser.** signet prints (and tries to open) a `/link` URL.
   The page shows the deploy key, the handle, and the same confirmation code
   your terminal printed — the server verifies the code against a stored hash
   before it renders an Approve button at all. Check the code matches: a page
   showing a different one is somebody else's link. Then approve or reject.
   *Proves you own the handle*, via your signed-in session.
4. **Prove the key.** signet fetches a CLI-link challenge for the deploy account
   with `GET /api/cli-link?account=<key>&network=<name>&purpose=link` (passing the
   network the command resolved) and signs it with `stellar tx sign`. *Proves you
   control the deploy key.* This challenge has its own home domain
   (`link.cli.<root domain>`), so a signed web sign-in challenge is refused here,
   and so is a signed `unlink` challenge. A signed CLI-link
   challenge is worthless for signing in. The response also carries the
   deployment's `network_passphrase`.
5. **Complete.** `POST /api/cli/pair/complete` checks both proofs and writes the
   binding. It refuses if the challenge was signed by any key other than the one
   the browser was shown — so what you approved is what gets linked.

Manual code entry. When stdin is a terminal and `--json` is not set, `signet link`
offers a prompt ("Paste the code shown in the browser, or wait for it to
finish") if the loopback listener could not be started, or if polling has
reported the pairing approved and no callback has arrived 10 seconds later. The
code is sent to `complete` as `handoffCode`, upper-cased, with spaces and hyphens
removed. Whichever finishes first wins: the callback, or the pasted code. With
`--json`, or when stdin is not a terminal, there is no prompt.

Ctrl-C while waiting prints `pairing abandoned; the link expires at <time>` to
stderr and exits `130`. The pairing is not cancelled server-side; it expires on
its own.

Linking a wallet that is already bound to the same profile succeeds and reports
`status: "already-linked"` (in `--json` output and in the text, `Already linked: …`)
instead of `linked`.

Two things race in step 3, and whichever answers first wins:

- a **loopback callback** — signet listens on `127.0.0.1` and the approval page
  calls it, so the command finishes the instant you approve;
- **polling** — signet asks the server for the pairing's status.

The callback is unreachable in plenty of real setups (SSH, containers, locked
down browsers), which is exactly why polling exists. Neither is trusted on its
own: both paths end at the same `complete`, which re-checks everything.

### Checking what you are linked as

```bash
signet whoami
# identity:   deploy
# publicKey:  GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U
# deployment: https://signet.example
# handle:     @alice
# source:     cli
# primary:    no, linked as an extra wallet
```

Three of those are local — the identity, its public key, the deployment — and
only the handle needs asking, because only the deployment knows what the key
currently resolves to. An unlinked key says so, and says what to do about it.

`--json` gives `{identity, publicKey, deployment, handle, linked}`. No secret
key appears in either mode; the public key comes from `stellar keys address`,
so signet never holds one to print.

### Waiting for the indexer

A new link shows on the profile once Signet's indexer has scanned the wallet,
which can take a few minutes. `signet link --wait` keeps going until then (5
minutes by default, or `--wait=<duration>` such as `--wait=90s`), then prints
what it found:

```bash
signet link --wait
# Linked GCKI… to @alice on testnet.
# indexed: 3 contracts found
```

Running out of time is not an error: it prints `still indexing, check
\`signet status\` later` and exits `0`, because the link itself succeeded. With
`--json` the result gains `indexing: { done, contracts?, contractsLowerBound? }`.

`signet status` shows the same progress at any time:

```bash
signet status
# deployment: https://signet.example (context prod)
# network:    testnet
# health:     ok (database up, registry up, pairing up)
# identity:   deploy
# publicKey:  GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U
# handle:     @alice
# wallets:
#   GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN  indexed  primary, onchain
#   GCKIZN6RQPU73ORI5Q6HM3PMRELBELH2DITSWEEU7G4K2E227BXPUX6U  indexing cli, this key
# contracts:  3 contracts
```

It reads `GET /api/v1/health`, `GET /api/v1/lookup/{publicKey}`, and for a
linked key `GET /api/v1/profiles/{handle}/wallets` and
`/api/v1/profiles/{handle}/contracts`. A deployment that does not answer its
health check is reported as `unreachable`, not as a failure.

`signet status --json` prints one object:

| Key | Type | Meaning |
| --- | --- | --- |
| `context` | string, omitted when none | The active context's name |
| `deployment` | string | The deployment URL |
| `network` | string | The network signet is set to |
| `health` | object | `{ status, db, registry, pairing }` from the health check, or `{ status: "unreachable", error }` |
| `identity` | string | The identity signet signs as |
| `publicKey` | string | Its public key |
| `handle` | string | The linked handle, `""` when not linked |
| `linked` | boolean | Whether the key is linked |
| `wallets` | array or null | `{ address, isPrimary, source, indexingPending, this }` per wallet of the handle; null when not linked or the deployment did not list them. `this` marks the key signet uses. |
| `contracts` | object or null | `{ count, lowerBound }`: how many contracts the handle's wallets deployed; `lowerBound` when the deployment could only list part |

### Unlinking

```bash
signet unlink            # asks first
signet unlink --yes      # required when stdin is not a terminal (CI, pipes)
```

Unlinking needs only the key proof — no browser step. The proof is the same
CLI-link challenge `signet link` uses (`GET /api/cli-link`), but minted with
`purpose=unlink`; neither a web sign-in challenge nor a signed `link` challenge
can unlink a wallet. Attaching a wallet makes
a claim about a profile; detaching withdraws one, and the person holding the key
is the one whose attestation the profile was showing. Requiring the handle
owner's consent too would mean a developer who left a team could not stop their
key feeding a profile they no longer control.

The **primary** wallet cannot be unlinked this way: it is the handle→wallet
claim itself, so releasing it is an on-chain registry operation.

## Choosing an identity

signet uses your `stellar` keystore; it has no keystore of its own.

```bash
stellar keys ls                          # what you have
stellar keys generate deploy             # make one
stellar keys add deploy --secret-key …   # import one
signet link --source deploy              # use a specific one
```

`--source` is remembered, so later runs do not ask again. It is stored with the
deployment URL in a config file:

| Platform | Location |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/signet/config.json` (usually `~/.config/signet/config.json`) |
| macOS | `~/Library/Application Support/signet/config.json` |
| Windows | `%AppData%\signet\config.json` |

```json
{
  "baseUrl": "https://signet.example",
  "source": "deploy"
}
```

Settings resolve highest-priority first: flag → environment → config file →
built-in default.

## Shell completion

`signet completion` generates tab-completion scripts for bash, zsh, fish and
PowerShell. In addition to subcommands and flags, it completes dynamic values:

- `--source` and `--sign-with-key` from the local `stellar` keystore (`stellar keys ls`);
- `--context`, `context use`, `context show`, and `context remove` from the contexts stored in `config.json`;
- `--network` (`testnet`, `mainnet`).

### Bash

```bash
source <(signet completion bash)

# Load on every shell start (Linux):
signet completion bash > ~/.local/share/bash-completion/completions/signet
```

### Zsh

```zsh
source <(signet completion zsh)

# Or write to a directory on $fpath before compinit runs:
signet completion zsh > "${fpath[1]}/_signet"
```

### Fish

```fish
signet completion fish | source

# Load on every shell start:
signet completion fish > ~/.config/fish/completions/signet.fish
```

### PowerShell

```powershell
signet completion powershell | Out-String | Invoke-Expression

# To persist across sessions, append the output of `signet completion powershell` to $PROFILE.
```

### `npx` caveat

Shell completion hooks bind to the `signet` command on `PATH` and invoke
`signet __complete ...` on every Tab press. Running through `npx @signet/cli`
does not put a `signet` binary on `PATH` (and spawning `npx` on each Tab press
would be too slow for interactive use). Install the CLI globally
(`npm install -g @signet/cli`) or place the release binary on `PATH` before
enabling shell completions.

## Self-hosted deployments

Point the CLI at your own instance:

```bash
signet link --url https://signet.internal.example      # once
export SIGNET_URL=https://signet.internal.example      # for a shell
```

`--url` is read from the config file but never written back by the flag — edit
the file to change the default deployment.

The origin you point at is also the only origin allowed to reach the loopback
callback while the command runs.

## CI

CI has no terminal to answer an identity prompt, so give it the identity up
front. `stellar tx sign` already reads `STELLAR_SIGN_WITH_KEY`, and signet
honours the same variable — one name, nothing to keep in sync.

```yaml
- name: Link the deploy wallet
  env:
    STELLAR_SIGN_WITH_KEY: ci-deploy
  run: |
    stellar keys add ci-deploy --secret-key "$SIGNET_DEPLOY_KEY"
    npx @signet/cli link --json
  # SIGNET_DEPLOY_KEY comes from secrets, and is only ever handed to
  # `stellar keys add` — never to signet.
```

**Pass an identity name, not a secret.** signet resolves your public key with
`stellar keys address <name>` before it can request a challenge — that is how
key material stays out of the process — and a secret on a command line is
visible in shell history and to anyone who can run `ps`. A secret-shaped value
or a seed phrase is refused, and the value is never echoed back into the log.

Unlike `--source`, neither `--sign-with-key` nor `STELLAR_SIGN_WITH_KEY` is
written to the config file: persisting something that might be a secret is not
signet's call.

`--json` is a global flag that works on every command (`link`, `unlink`,
`whoami`, `identity`, `version`, and whatever is added next). It writes one JSON
object to stdout and sends progress, prompts and diagnostics to stderr, so a
pipeline can parse the result without scraping human text. Without `--json`,
`signet link` keeps printing its progress lines on stdout, as it always has:

```json
{ "handle": "alice", "publicKey": "GCKI…", "network": "testnet", "status": "linked" }
```

On failure stdout stays empty and the error goes to stderr, so stdout is always
either the one object or nothing.

## Exit codes

Stable, so scripts can branch on the code rather than on message text.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic or unexpected error |
| `2` | Invalid input — a malformed handle or public key, or `unlink` run non-interactively without `--yes` |
| `3` | Configuration — the config file, a flag or env var, the `stellar` CLI (missing or too old), or a deployment with no database |
| `4` | No identity — `stellar` could not resolve the requested identity |
| `5` | Signing failed |
| `6` | Network — the deployment could not be reached, or answered unexpectedly |
| `7` | Timed out waiting for approval |
| `8` | Approval rejected in the browser |
| `9` | Already linked — the wallet has a conflicting binding |
| `10` | Diff found — a sandbox comparison found a difference; a finding, not a failure |
| `11` | Host unsupported — the simulator can't serve this network |
| `12` | Build failed — the contract under test failed to build |
| `13` | Simulator failure — the simulator itself failed, not the contract call it was running |
| `14` | No spec — the contract's WASM has no interface spec (`contractspecv0`), so `visualise` has nothing to draw |
| `130` | Interrupted — Ctrl-C while the command was waiting; `link` abandons the pairing |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Not sure which key you are linked as | Several keystore identities, and the config file remembers one | `signet whoami` — it prints the identity, its public key, the deployment, and the handle |
| `signet is set to network mainnet, but … serves testnet` (exit `3`) | The deployment is configured for a different network than the one signet resolved (from `--network`, `SIGNET_NETWORK` or the context) | Pass the deployment's network, e.g. `--network testnet`, or switch to a context for that network with `signet context use <name>` |
| `no identity available` (exit `4`) | No identity in the `stellar` keystore, or the named one does not exist | `stellar keys ls` to see what you have; `stellar keys generate <name>` or `stellar keys add <name> --secret-key …`; then `signet link --source <name>` |
| `stellar CLI not found on PATH` (exit `3`) | signet cannot sign without it | Install it: <https://developers.stellar.org/docs/tools/cli/install-cli> |
| `stellar CLI is older than the required minimum version` (exit `3`) | Older than 25.2.0, so `tx sign --sign-with-key` / stdin are missing | Upgrade `stellar` |
| Nothing opens; the URL is printed instead | No display detected — SSH, a container, or a headless box. Not an error | Open the printed URL on any machine you can browse from. The link still works: signet polls for the approval |
| Approved in the browser, terminal still waiting a few seconds | The browser could not reach `127.0.0.1` — normal over SSH or in a container | Nothing. Polling picks it up on the next check. The page says so when it happens |
| Chrome shows a network error calling the callback | Private Network Access preflight refused | Check the deployment URL matches the one you passed: only that origin is allowed to reach the callback |
| `no approval within 5m0s` (exit `7`) | The pairing expired before it was approved | Run `signet link` again; the printed URL is in the message |
| `the approval was refused in the browser` (exit `8`) | Reject was clicked | Nothing was linked. Re-run to try again |
| `This deploy account is already bound to a different profile` (exit `9`) | Another profile holds this wallet | Whoever holds it unlinks it from **Wallets** in the dashboard, then link again. The error deliberately does not say who holds it — see [`WALLET_ATTACHMENT.md`](WALLET_ATTACHMENT.md) |
| `This challenge was signed by a different account than the one approved in the browser` | The identity changed between approving and signing | Re-run `signet link` so the key shown and the key signed are the same |
| `CLI linking requires a database, and this deployment has none configured` (exit `3`) | The deployment has no `DATABASE_URL`; a link would have nowhere to be written | The operator provisions one (tracked in #191). Not something you can fix from the terminal — and `/link` says so before you approve |
| `That confirmation code does not match the one shown in the browser` | The pasted handoff code is wrong or from another attempt | Copy it again from the approval page, or re-run `signet link` |
| `pairing abandoned; the link expires at …` (exit `130`) | You pressed Ctrl-C while `signet link` was waiting | Nothing was linked. Run `signet link` again, or finish approving the printed link before it expires |
| A sandbox run exits `10` with no error text | A comparison found a diff — that is the result, not a failure | Read the printed diff; in CI, branch on `$? -eq 10` to treat "changed" differently from "broken" |
| `host unsupported` (exit `11`) | The simulator does not model this network's protocol version or host functions | Run against a network the simulator supports, or upgrade the CLI for a newer simulator |
| `contract build failed` (exit `12`) | The contract under test did not compile, so nothing ran | Fix the build first — the same errors appear building it directly |
| `simulator failure` (exit `13`) | The simulator itself broke — distinct from your contract call failing inside it | Re-run with `--json` for the structured error and report it; your contract may be fine |

## Protocol

The `/api/cli/*` endpoints serve the `signet` CLI only and change with it. Integrators use `/api/v1`.

This section is the contract between the Go CLI (`cli/internal/pair`,
`cli/internal/link`) and the route handlers under `apps/web/app/api/cli/**`
and `apps/web/app/api/cli-link/route.ts`. A change to either side updates it
in the same PR. That is the check that would have caught #616, where the CLI
sent a network name and the server compared it against a passphrase.

Parts that an open issue in this epic will change are tagged with that issue,
for example **(#597)**. Whoever lands that issue updates the tagged text. #616
has landed, and the network-naming section below describes the wire after it.

All bodies are JSON. Every error body is `{ "error": "<message>" }`, and the
messages are written for the person at the terminal: the CLI prints them
verbatim.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant CLI as signet (terminal)
    participant LB as loopback 127.0.0.1
    participant B as Browser (/link)
    participant S as Signet deployment

    CLI->>S: POST /api/cli/pair/start {network, publicKey}
    S-->>CLI: {state, pollToken, expiresAt}
    CLI->>LB: bind 127.0.0.1:0 (optional)
    CLI->>B: open /link?code=state[&callback=…&callback_state=…]
    B->>S: POST /api/cli/pair/approve {state} (session cookie)
    S-->>B: {ok, handoffCode}
    par whichever answers first
        B->>LB: GET callback?state=callback_state
        LB-->>B: 200 (or 400 on a state mismatch; the wait continues)
    and
        loop every 2s until the TTL
            CLI->>S: GET /api/cli/pair/status?pollToken=…
            S-->>CLI: {status}
        end
    end
    CLI->>S: GET /api/auth/sep10?account=G… (#597: GET /api/cli-link)
    S-->>CLI: {transaction, network_passphrase}
    CLI->>CLI: stellar tx sign --sign-with-key <identity>
    CLI->>S: POST /api/cli/pair/complete {state, transaction}
    S-->>CLI: {ok, wallet, handle}
```

`reject` takes the place of `approve` when the developer refuses, and the next
poll returns `rejected`. `unlink` and `whoami` are separate calls that do not
involve a pairing:

- `signet unlink` fetches a challenge (same as step 12), signs it, and sends
  `POST /api/cli/unlink {transaction}`.
- `signet whoami` sends `GET /api/v1/lookup/{publicKey}` and nothing else, or,
  when a deployment older than that route answers it 404,
  `GET /api/cli/whoami?publicKey=G…` (which carries no `source` or `isPrimary`).

#### The approval URL and the loopback callback

The CLI builds `<baseURL>/link?code=<state>` in `link.prepare`. When it could
bind a loopback port, it adds
`&callback=http://127.0.0.1:<port>/callback&callback_state=<32 random bytes, base64url>`.
**(#596** adds `&user_code=…`.**)**

- `/link` passes `callback` through `safeCallbackUrl`, which accepts only a
  plain `http:` URL on a loopback host. Anything else is dropped, so the page
  cannot be used as an open redirect.
- After a successful `approve`, the page calls `fetch(callback + "?state=" +
  callback_state)` rather than navigating to it. If that fetch fails, the tab
  stays on the page, which says the terminal will pick up the approval by
  polling.
- The loopback server answers `OPTIONS` with `204` and CORS headers scoped to
  the deployment's origin, which is what Chrome's Private Network Access
  preflight needs. A matching `state` gets `200` and ends the wait. A
  mismatched one gets `400`, and the server keeps listening, so a stray page
  cannot abort the link.

### Which credential authenticates each call

| Endpoint | Called by | Credential |
| --- | --- | --- |
| `POST /api/cli/pair/start` | CLI | None. It only mints something to show the user. |
| `GET /api/cli/pair/status` | CLI | The poll token returned by `start` |
| `POST /api/cli/pair/approve` | `/link` page | Browser session cookie, plus a same-origin check |
| `POST /api/cli/pair/reject` | `/link` page | Browser session cookie, plus a same-origin check. No profile is needed. |
| `POST /api/cli/pair/complete` | CLI | A signed SEP-10 challenge for the deploy account, plus an already-approved pairing |
| `POST /api/cli/unlink` | CLI | A signed SEP-10 challenge for the wallet being removed |
| `GET /api/v1/lookup/{address}` | CLI (`whoami`), anyone | None. It answers from public data. |
| `GET /api/cli/whoami` | Older CLIs. Deprecated by `/api/v1/lookup/{address}` | None. It answers from public data. |
| `GET /api/auth/sep10` | CLI | None. It issues the challenge. |
| `GET` / `POST /api/cli-link` | Not called by the CLI yet **(#597)** | None for `GET`. `POST` checks a signed challenge. |

**The poll token is deliberately not the pairing code.** The code (`state`) is
in the `/link` URL the developer opens. That URL may end up in a chat, a
screenshot, or browser history, and seeing a link should not let someone watch
the pairing behind it. The poll token is 32 random bytes, returned once by
`start`, and stored only as a SHA-256 hash. It never appears in a URL the
browser sees. An unknown token and a wrong token both get the same `404`, so
`status` cannot be used to test which tokens exist.

Knowing the poll token only lets you read progress. Approving still requires
the browser session, and attaching still requires the signed challenge, so the
polling path reaches the same trust boundary as the loopback path.

### Network names and passphrases

Since #616, every field on the wire that selects a network carries its **name**.
A **passphrase** appears only where Stellar's own signing needs it.

| Where | Carries | Values |
| --- | --- | --- |
| `pair/start` request `network` | Name | `testnet` or `mainnet`. `public` and `pubnet` are accepted as aliases. For one release, a full passphrase is still accepted: it is mapped back to its name and a deprecation warning is logged. |
| `PairingState.network` (stored, not on the wire) | Name | The canonical name that `start` resolved |
| `whoami` response `network` | Name | The deployment's configured network |
| `signet link --json` output `network` | Name | The `--network` flag's value (default `testnet`) |
| `GET /api/cli-link` query `purpose` | `link` or `unlink` | What the challenge is for. Defaults to `link` when omitted; any other value is a `400`. |
| `GET /api/cli-link` query `network` | Name | Compared against the deployment's network by mainnet or not mainnet. An unrecognized value is treated as not mainnet rather than rejected. |
| `sep10` / `cli-link` challenge response `network_passphrase` | Passphrase | For example `Test SDF Network ; September 2015` |
| The signed challenge XDR | Passphrase | Included in the hash that is signed, as the network ID. It is not a readable field. |

`start` rejects a network that does not match the deployment with a `400`. It
does this before any row exists, so a mismatch no longer surfaces only after
the user has approved in the browser. `complete` checks the network again,
which only matters if the deployment's configuration changed in between.

Since #618 the CLI checks first. `signet link` and `signet unlink` read the
deployment's `stellar.toml` (`NETWORK_PASSPHRASE`, `SIGNING_KEY` and
`WEB_AUTH_ENDPOINT` only, once per process) before any other request, and map
the passphrase back to its name with the table above
(`packages/types/src/network.ts`). A mismatch is a configuration error,
exit `3`:

```text
configuration error: signet is set to network mainnet, but https://signet.example serves testnet ("Test SDF Network ; September 2015"); use --network testnet, or signet context use <name> for a context on testnet
```

A network name signet does not recognise cannot match any deployment, so it
fails the same way. A deployment on a custom network is named by its
passphrase.

**The `stellar` CLI's own default network is not checked.** `stellar` keeps a
default network of its own (`stellar network use`), and it can differ from
both `--network` and the deployment. Detecting it would mean parsing
`stellar env` / `stellar network ls` output, which is not a stable interface
across the `stellar` versions signet supports, so signet does not read it and
does not warn about it. It does not need to: signet never relies on that
default. Every signature passes the deployment's `network_passphrase`
explicitly (`stellar tx sign --network-passphrase …`, #602), so signing is
correct whichever network `stellar` defaults to.

### How a response becomes an exit code

The CLI never matches on status codes directly. It turns each response into one
of the sentinel errors in `cli/internal/exitcode/exitcode.go`. The rules are:

1. **`pair.Client`** (start, status, complete, unlink, whoami): any non-2xx
   response becomes `ErrNetwork` (exit `6`), except `503`, which becomes
   `ErrConfiguration` (exit `3`). A `503` means the deployment has no database.
   That is the operator's problem, and calling it a network error would send
   the developer to check their own connection. An unreachable host or an
   undecodable body is also `6`.
2. **`FetchChallenge`** (`GET /api/auth/sep10`): *every* non-2xx response,
   `503` included, becomes `6`.
3. **`classifyComplete`**: after rule 1, a `complete` error whose message
   contains `already bound to a different profile` or `already been completed`
   is changed to `ErrAlreadyLinked` (exit `9`). This matches on **message
   text**, so rewording either message in `pair/complete/route.ts` silently
   changes the exit code to `6`.
4. **Polling** does not end the wait on an error. A laptop that slept or a
   deployment that restarted can recover, so a failed poll is retried until the
   pairing's TTL (5 minutes). At the TTL, the CLI exits `7` if the last poll
   succeeded. Otherwise it exits with that poll's error, which is `6`, or `3`
   for a `503`. A poll that returns `rejected` exits `8`, and one that returns
   `expired` exits `7`.
5. **Browser-only routes** (`approve`, `reject`) return their errors to the
   `/link` page, never to the CLI. Their only effect on the terminal is through
   the pairing's status.

Any unhandled exception in a route handler becomes a Next.js `500`, which rule
1 or 2 turns into exit `6`. It is not repeated in the tables below. Every route
sends `429 Too many requests` with a `retry-after` header when over its
rate-limit budget, and the tables list it.

### Endpoints

#### `POST /api/cli/pair/start`

Request:

```json
{ "network": "testnet", "publicKey": "GCKI…" }
```

`publicKey` is optional today and is recorded unverified so that `/link` can
show which key is being approved. **(#596** makes it required, and a missing
key becomes a `400`.**)**

Success `200`:

```json
{ "state": "<pairing id>", "pollToken": "<base64url>", "expiresAt": "2026-09-29T12:05:00.000Z" }
```

**(#596** adds `userCode`.**)**

| Status | Message | Exit |
| --- | --- | --- |
| 400 | `publicKey must be a Stellar G… address` | `6`. The CLI validates the key first, so in practice it exits `2` before sending the request. |
| 400 | `network must be a Stellar network name, e.g. "testnet" or "mainnet"` | `6` |
| 400 | `Network mismatch: the CLI requested "<name>" but this deployment is configured for "<name>".` | `6` |
| 429 | `Too many requests` | `6` |
| 503 | `CLI linking requires a database, and this deployment has none configured. …` | `3` |

#### `GET /api/cli/pair/status?pollToken=…`

Success `200`: `{ "status": "pending" | "approved" | "rejected" | "completed" | "expired" }`.
`expired` is not stored. It is reported for a row that is still `pending` after
its expiry time.

| Status | Message | Exit (see rule 4) |
| --- | --- | --- |
| 400 | `pollToken is required` | Retried; `6` at the TTL |
| 404 | `Pairing not found` (for an unknown token and a wrong token alike) | Retried; `6` at the TTL |
| 429 | `Too many requests` | Retried; `6` at the TTL |
| 503 | `CLI linking requires a database, …` | Retried; `3` at the TTL |

| `status` value | What the CLI does |
| --- | --- |
| `pending` | Keeps waiting, and prints the time remaining |
| `approved`, `completed` | Moves on to the challenge |
| `rejected` | Exits `8` |
| `expired` | Exits `7` |

#### `POST /api/cli/pair/approve`

Called from `/link` with the session cookie. Request: `{ "state": "<pairing id>" }`.

Success `200`: `{ "ok": true, "handoffCode": "<8 chars>" }`. The handoff code
is minted at approval time and returned only to the session that approved. It
exists for the manual path where the developer pastes it into the terminal
(see `complete`).

The route checks, in order: same origin, the rate limit, the session, the body,
and then the pairing.

| Status | Message | Exit |
| --- | --- | --- |
| 403 | `Cross-origin request rejected` | Not applicable (browser only); the CLI keeps waiting and exits `7` at the TTL |
| 429 | `Too many requests` | Same as above |
| 401 | `Not signed in` | Same as above |
| 400 | `state is required` | Same as above |
| 404 | `Pairing not found — it may have already been used` | Same as above |
| 410 | `This pairing has expired — restart it from the CLI` | Same as above |
| 409 | `This pairing has already been approved` | Same as above |
| 409 | `Claim a handle before pairing a CLI` | Same as above |
| 503 | `CLI linking requires a database, …` | Same as above |

**(#596** refuses a pairing with no declared key here.**)**

#### `POST /api/cli/pair/reject`

This has the same caller, credential, and request as `approve`, but no profile
is required. Success `200`: `{ "ok": true }`. The CLI's next poll sees
`rejected` and exits `8`.

| Status | Message | Exit |
| --- | --- | --- |
| 403 | `Cross-origin request rejected` | Not applicable (browser only) |
| 429 | `Too many requests` | Same as above |
| 401 | `Not signed in` | Same as above |
| 400 | `state is required` | Same as above |
| 404 | `Pairing not found — it may have already been used` | Same as above |
| 410 | `This pairing has expired — restart it from the CLI` | Same as above |
| 409 | `This pairing has already been answered` | Same as above |
| 503 | `CLI linking requires a database, …` | Same as above |

#### `GET /api/auth/sep10?account=G…` (the challenge)

This is the web sign-in endpoint. `signet link` and `signet unlink` no longer use
it: they call `GET /api/cli-link` (#597) with `purpose=link|unlink` (#622), so a
sign-in challenge cannot complete a pairing or an unlink.

Success `200`: `{ "transaction": "<unsigned XDR>", "network_passphrase": "…" }`.

| Status | Message | Exit (rule 2) |
| --- | --- | --- |
| 400 | `account is required and must be a valid Stellar address` | `6` |
| 400 | `home_domain must be <domain>`. Only sent when `home_domain` is supplied, which the CLI never does. | `6` |
| 400 | `Could not build challenge` | `6` |
| 429 | `Too many requests` | `6` |
| 503 | The signing-key configuration error, for example `SEP10_SIGNING_SECRET must be set in production` | `6` |

#### `POST /api/cli/pair/complete`

Request:

```json
{ "state": "<pairing id>", "transaction": "<signed XDR>", "handoffCode": "<optional>" }
```

`handoffCode` is checked only when it is present. `signet link` sends one only
when the developer pasted it at the prompt (see "Manual code entry" above);
otherwise it is omitted from the body.

Success `200`: `{ "ok": true, "wallet": "G…", "handle": "alice",
"indexingPending": false, "status": "linked" }`. `handle` is `null` if the
profile has no handle. Completing again for a wallet already bound to the
*same* profile succeeds and is idempotent; `status` is then `already-linked`
instead of `linked`, and the CLI reports it as such.

The `CompleteFailure` reasons come from `apps/web/lib/server/pairing.ts`. The
checks run in this order: `not-found`, `already-completed`, `not-approved`,
`expired`, `network-mismatch`, `bad-challenge`, `bad-handoff`, `key-mismatch`,
`replayed`, and finally `already-completed` or `wallet-bound-elsewhere` inside
the write transaction.

| Status | Reason | Message | Exit |
| --- | --- | --- | --- |
| 400 | — | `state and transaction are required` | `6` |
| 429 | — | `Too many requests` | `6` |
| 503 | `unavailable` | `CLI linking requires a database, …` | `3` |
| 404 | `not-found` | `Pairing not found — restart it from the CLI` | `6` |
| 410 | `expired` | `This pairing has expired — restart it from the CLI` | `6` |
| 409 | `not-approved` | `This pairing has not been approved in the browser yet` | `6` |
| 409 | `already-completed` | `This pairing has already been completed` | `9` (rule 3) |
| 400 | `network-mismatch` | `This pairing's network does not match the deployment's configured network` | `6` |
| 401 | `bad-challenge` | `Invalid or unsigned challenge transaction` (a web sign-in challenge lands here, and so does an `unlink`-purpose one) | `6` |
| 403 | `key-mismatch` | `This challenge was signed by a different account than the one approved in the browser` **(#596:** a pairing with no declared key lands here too**)** | `6` |
| 403 | `bad-handoff` | `That confirmation code does not match the one shown in the browser` | `6` |
| 401 | `replayed` | `This signed challenge has already been used` | `6` |
| 409 | `wallet-bound-elsewhere` | `This deploy account is already bound to a different profile` | `9` (rule 3) |

#### `POST /api/cli/unlink`

Request: `{ "transaction": "<signed XDR>" }`. The challenge is fetched and
signed the same way as for `link`. Success `200`:
`{ "ok": true, "wallet": "G…", "handle": "alice" }`, where `handle` can be
`null`.

The `UnlinkFailure` reasons come from `apps/web/lib/server/cli-unlink.ts`. The
checks run in this order: `bad-challenge`, `replayed`, `not-linked`, and
`primary-wallet`. Unlike `complete`, no response from this route is changed to
exit `9`.

| Status | Reason | Message | Exit |
| --- | --- | --- | --- |
| 400 | — | `transaction is required` | `6` |
| 429 | — | `Too many requests` | `6` |
| 503 | `unavailable` | `CLI wallet unlinking requires a database, …` | `3` |
| 401 | `bad-challenge` | `Invalid or unsigned challenge transaction` (only an `unlink`-purpose CLI-link challenge passes; a `link` one is refused) | `6` |
| 401 | `replayed` | `This signed challenge has already been used` | `6` |
| 404 | `not-linked` | `That wallet is not linked to any profile` | `6` |
| 409 | `primary-wallet` | `That wallet is the profile’s primary wallet — releasing it is an on-chain registry operation, not an unlink` | `6` |

#### `GET /api/cli/whoami?publicKey=G…`

Deprecated (#645): `signet whoami` asks `GET /api/v1/lookup/{address}` (see
[API_V1.md](API_V1.md#which-handle-is-a-wallet-linked-to)), which also says how
the wallet was linked and whether it is primary. This route stays for older
CLIs; every answer carries `Deprecation` and a `Link: <…>; rel="successor-version"`
naming the v1 route.

Success `200`:

```json
{ "publicKey": "G…", "handle": "alice", "linked": true, "network": "testnet" }
```

`handle` is `null` and `linked` is `false` for an unlinked key. This route works
without a database, because it falls back to the on-chain registry, so it never
returns `503`.

| Status | Message | Exit |
| --- | --- | --- |
| 400 | `publicKey is required and must be a valid Stellar address` | `6`. The CLI validates the key first, so in practice it exits `2`. |
| 429 | `Too many requests` | `6` |

#### `GET` / `POST /api/cli-link`

This is the CLI-specific SEP-10 exchange. Its challenges use the home domain
`<purpose>.cli.<root domain>` (`link.cli.…` or `unlink.cli.…`), so a signature
made for one context is never valid in another: not for web sign-in, and not
for the other purpose either. A challenge signed intending to link therefore
cannot be sent to `/api/cli/unlink` to detach the wallet, and the reverse. The
purpose lives in the domain, rather than in an extra operation, because the
SEP-10 reader already checks the domain and nothing else has to remember to.
The old purpose-less `cli.<root domain>` challenge verifies for neither. `link`
and `unlink` request the matching purpose, and `complete` and `unlink` verify it.
Both methods send `Access-Control-Allow-Origin: *`. `OPTIONS` returns `200` with
the allowed methods and headers.

`GET ?account=G…&network=<name>&purpose=link|unlink` succeeds with
`{ "transaction": "<unsigned XDR>", "network_passphrase": "…" }`. `purpose`
defaults to `link`, which is what a CLI released before purposes asks for.

| Status | Message | Exit (after #597, under rule 2) |
| --- | --- | --- |
| 400 | `account is required and must be a valid Stellar address` | `6` |
| 400 | `network is required (e.g. "testnet" or "mainnet")` | `6` |
| 400 | `purpose must be "link" or "unlink"` | `6` |
| 400 | `Network mismatch: the CLI requested "<value>" but this deployment is configured for "<name>".` | `6` |
| 400 | `Could not build challenge` | `6` |
| 429 | `Too many requests` | `6` |
| 503 | The signing-key configuration error | `6` |

`POST {"transaction": "<signed XDR>", "purpose": "link"}` (`purpose` optional,
default `link`) succeeds with
`{ "verified": true, "publicKey": "G…" }`. It only verifies. It attaches
nothing.

| Status | Message | Exit |
| --- | --- | --- |
| 400 | `transaction is required` | Not applicable (not called by the CLI) |
| 401 | The SEP-10 verifier's message, for example `Challenge was not signed by the client account`, or else `Invalid challenge transaction` | Same as above |
| 429 | `Too many requests` | Same as above |
| 503 | The signing-key configuration error | Same as above |

## See also

- [`WALLET_ATTACHMENT.md`](WALLET_ATTACHMENT.md) — the policy for a wallet
  already attached elsewhere, and how a contested one is released.
- [`ENVIRONMENT.md`](ENVIRONMENT.md) — what a deployment needs configured,
  including what degrades without a database.
- `cli/README.md` — building, testing, and the module layout.

## Challenge endpoint

`GET /api/cli-link?account=<G…>&network=<name>&purpose=<link|unlink>` issues the
CLI-link challenge used by `signet link` (`purpose=link`) and `signet unlink`
(`purpose=unlink`). `POST /api/cli-link` (verify
only; it links nothing) is **deprecated**: nothing in the CLI or the web app
calls it now that pairing completion and unlink verify the challenge
themselves. It is kept for callers of released versions and will be removed in a
future breaking change. Do not build on it.
