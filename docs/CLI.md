# Signet CLI

`signet` binds the wallet you deploy contracts from to your Signet handle, so
the contracts that wallet has deployed are attributed to you.

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

`npx` fetches a small wrapper that downloads the right prebuilt binary for your
platform. To keep it around:

```bash
npm install -g @signet/cli
signet --version
```

Building from source needs Go (see `cli/go.mod` for the version):

```bash
cd cli && go build ./cmd/signet
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

1. **Resolve the deploy identity.** `stellar keys ls` / `stellar keys address`
   turn your chosen identity into a public key. If you have exactly one
   identity it is used; if you have several you are asked which. *Proves
   nothing yet — it is just deciding which key the rest of the flow is about.*
2. **Mint a pairing.** signet calls `POST /api/cli/pair/start`, declaring that
   public key. The declaration is **not** trusted; it exists so the browser can
   show you which key you are approving.
3. **Approve in the browser.** signet prints (and tries to open) a `/link` URL.
   The page shows the deploy key and the handle, and you approve or reject.
   *Proves you own the handle*, via your signed-in session.
4. **Prove the key.** signet fetches a SEP-10 challenge for the deploy account
   and signs it with `stellar tx sign`. *Proves you control the deploy key.*
5. **Complete.** `POST /api/cli/pair/complete` checks both proofs and writes the
   binding. It refuses if the challenge was signed by any key other than the one
   the browser was shown — so what you approved is what gets linked.

Two things race in step 3, and whichever answers first wins:

- a **loopback callback** — signet listens on `127.0.0.1` and the approval page
  calls it, so the command finishes the instant you approve;
- **polling** — signet asks the server for the pairing's status.

The callback is unreachable in plenty of real setups (SSH, containers, locked
down browsers), which is exactly why polling exists. Neither is trusted on its
own: both paths end at the same `complete`, which re-checks everything.

### Unlinking

```bash
signet unlink            # asks first
signet unlink --yes      # for scripts
```

Unlinking needs only the key proof — no browser step. Attaching a wallet makes
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

`--json` writes one JSON object to stdout and sends progress to stderr, so a
pipeline can parse the result without scraping human text:

```json
{ "handle": "aquawolf", "publicKey": "GASA…", "network": "testnet", "status": "linked" }
```

On failure stdout stays empty and the error goes to stderr, so stdout is always
either the one object or nothing.

## Exit codes

Stable, so scripts can branch on the code rather than on message text.

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic or unexpected error |
| `2` | Invalid input — a malformed handle or public key |
| `3` | Configuration — the config file, a flag or env var, the `stellar` CLI (missing or too old), or a deployment with no database |
| `4` | No identity — `stellar` could not resolve the requested identity |
| `5` | Signing failed |
| `6` | Network — the deployment could not be reached, or answered unexpectedly |
| `7` | Timed out waiting for approval |
| `8` | Approval rejected in the browser |
| `9` | Already linked — the wallet has a conflicting binding |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
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

## See also

- [`WALLET_ATTACHMENT.md`](WALLET_ATTACHMENT.md) — the policy for a wallet
  already attached elsewhere, and how a contested one is released.
- [`ENVIRONMENT.md`](ENVIRONMENT.md) — what a deployment needs configured,
  including what degrades without a database.
- `cli/README.md` — building, testing, and the module layout.
