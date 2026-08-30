# Signet CLI

`signet link` binds the wallet you deploy contracts with to your Signet handle.
That binding is what turns on-chain deploys into a verifiable career record, so
the flow is built to prove the link rather than to assert it.

> **Status.** The CLI is being built across [#251](https://github.com/blockchain-maxis/signet/issues/251)
> and the issues that follow it. This document describes the designed
> behaviour and is the contract those issues are implemented against — where a
> section describes something not yet on `main`, the issue that lands it is
> named. The one part enforced today is
> [Linking requires a database](#linking-requires-a-database).

---

## Contents

- [Install](#install)
- [Prerequisites](#prerequisites)
- [The link flow, and what each step proves](#the-link-flow-and-what-each-step-proves)
- [Choosing an identity](#choosing-an-identity)
- [Configuration and precedence](#configuration-and-precedence)
- [Using it from CI](#using-it-from-ci)
- [Self-hosted deployments](#self-hosted-deployments)
- [Machine-readable output](#machine-readable-output)
- [Exit codes](#exit-codes)
- [Linking requires a database](#linking-requires-a-database)
- [Troubleshooting](#troubleshooting)

---

## Install

No install step is required:

```bash
npx @signet/cli link
```

The npm package is a thin wrapper that fetches the cross-compiled binary for
your platform ([#293](https://github.com/blockchain-maxis/signet/issues/293)).
For repeated use, install it once:

```bash
npm install -g @signet/cli
signet link
```

`npx` is the documented default because linking is something most developers do
once per machine, and a one-shot command should not leave a global install
behind.

---

## Prerequisites

**The [`stellar` CLI](https://developers.stellar.org/docs/tools/cli/install-cli),
version 25.2.0 or newer, on your `PATH`.**

This is not an incidental dependency. The Signet CLI **never handles your
secret key** — not in memory, not in `argv`, not in logs, not in a crash dump.
Identity listing, public-key resolution and signing are all delegated to
`stellar`:

```
stellar keys ls                              # which identities exist
stellar keys public-key <identity>           # resolve the G… address
stellar tx sign --sign-with-key <identity>   # sign; the secret never leaves stellar
```

Delegating means Signet takes on no key custody, and inherits `stellar`'s OS
secure-store support and `--sign-with-ledger` hardware signing for free
([#253](https://github.com/blockchain-maxis/signet/issues/253)).

The version is checked before any work happens, so a missing or too-old
`stellar` produces a message naming the required version and the install page,
rather than a raw exec error pointing at the wrong tool
([#297](https://github.com/blockchain-maxis/signet/issues/297)).

If you have no `stellar` identity, you have deployed no contracts and have
nothing to link yet.

---

## The link flow, and what each step proves

```
$ signet link

  ✓ stellar 25.2.0
  ✓ identity: deploy-key (GCEX…7QK4)

  Opening https://signet.dev/link/HRTV-2K9P

  Waiting for approval… (expires in 5:00)

  ✓ linked  @aquawolf  ←  GCEX…7QK4
```

Five steps, each proving something the next one relies on:

| Step         | What happens                                                                                               | What it proves                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Preflight | `stellar --version` is checked; an identity is resolved                                                    | The signer exists and can be reached before anything user-visible starts                                                                             |
| 2. Pair      | The CLI asks the deployment to mint a single-use pairing code, and starts a loopback server on `127.0.0.1` | The pairing is bound to _this_ process; the code is useless to anyone who did not start it                                                           |
| 3. Approve   | Your browser opens the approval page; you sign in as your handle and approve                               | **You control the handle.** Browser-side session, never the CLI's business                                                                           |
| 4. Sign      | The CLI signs a challenge with the deploy identity via `stellar tx sign`                                   | **You control the wallet.** The signature is over a challenge scoped to this pairing ([#269](https://github.com/blockchain-maxis/signet/issues/269)) |
| 5. Complete  | The browser posts back to the loopback server; the CLI completes the pairing                               | Both proofs arrived in one session, so the handle and the wallet are the same person                                                                 |

Steps 3 and 4 are separate on purpose. The handle proof happens in the browser
where the session lives; the wallet proof happens on the machine where the key
lives. Neither component ever sees the other's secret.

**No browser?** Over SSH, in a container, or with `--no-browser`, the CLI
prints the URL for you to open manually. The auto-open failing is never fatal —
a command that hangs with no visible way to proceed is the worst first-run
experience on a remote box
([#257](https://github.com/blockchain-maxis/signet/issues/257)).

---

## Choosing an identity

The CLI lists identities with `stellar keys ls` and picks one by this rule:

1. `--source <identity>` if given.
2. The last identity you linked with, from the config file.
3. If exactly one identity exists, that one.
4. Otherwise, prompt.

```bash
signet link --source deploy-key
```

### Where the keystore lives

You do not need to know this — `stellar` owns the format and may change it, and
the Signet CLI never reads it directly. It is documented only so you know
whether an identity is available to the account running the command:

| Platform | Location                                                                     |
| -------- | ---------------------------------------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/stellar/identity/` (usually `~/.config/stellar/identity/`) |
| macOS    | `~/.config/stellar/identity/`                                                |
| Windows  | `%APPDATA%\stellar\identity\`                                                |

The practical consequence: an identity created as your user is not visible to
`root`, to a different user, or inside a container that does not mount that
directory. That is the usual cause of "no identity found" on a machine where
`stellar keys ls` clearly works.

---

## Configuration and precedence

The CLI reads a config file from your OS config directory
(`os.UserConfigDir()`) for the deployment URL and the last identity used, so
repeat runs need no flags
([#262](https://github.com/blockchain-maxis/signet/issues/262)).

**Precedence, highest first:**

```
--url / --source  >  SIGNET_URL / STELLAR_SIGN_WITH_KEY  >  config file  >  default
```

| Setting          | Flag       | Environment             | Config key | Default              |
| ---------------- | ---------- | ----------------------- | ---------- | -------------------- |
| Deployment URL   | `--url`    | `SIGNET_URL`            | `baseUrl`  | `https://signet.dev` |
| Signing identity | `--source` | `STELLAR_SIGN_WITH_KEY` | `identity` | prompt               |

No config file is needed for the default deployment.

---

## Using it from CI

CI cannot answer an interactive prompt, so the signing identity must come from
the environment. `stellar tx sign --sign-with-key` accepts an identity name, a
raw `SC…` secret, or a seed phrase, and reads `STELLAR_SIGN_WITH_KEY` itself
([#254](https://github.com/blockchain-maxis/signet/issues/254)).

```yaml
- name: Link the deploy wallet
  env:
    STELLAR_SIGN_WITH_KEY: ${{ secrets.SIGNET_DEPLOY_KEY }}
  run: npx @signet/cli link --no-browser --json
```

Store the deploy key in your CI secret store under whatever name you like —
`SIGNET_DEPLOY_KEY` above is a convention, not something the CLI reads. The CLI
reads **`STELLAR_SIGN_WITH_KEY`**, because that is the variable `stellar tx
sign` already honours, and introducing a second name for the same secret would
mean copying it between variables in every pipeline.

When either `--sign-with-key` or `STELLAR_SIGN_WITH_KEY` is set, no prompt
appears. The value is never echoed and never logged.

> The approval step still needs a human in a browser once. CI usage is for
> re-linking and verification after the first interactive link, not for
> bootstrapping a handle unattended — an unattended path would defeat the
> handle proof in step 3.

---

## Self-hosted deployments

Signet is Apache-2.0 and [`docs/DEPLOYMENT.md`](DEPLOYMENT.md) documents running
your own. Point the CLI at it:

```bash
signet link --url https://signet.internal.example
# or persist it
SIGNET_URL=https://signet.internal.example signet link
```

The URL must be `https` in any deployment reachable off `localhost`: the
approval page posts back to a loopback address, and browsers apply
[Private Network Access](https://developer.chrome.com/blog/private-network-access-preflight)
rules to that request. See
[loopback blocked](#loopback-blocked) below.

Your deployment **must have a database** — see the next section.

---

## Machine-readable output

`--json` writes a single JSON object to stdout and nothing else, so a pipeline
can parse the result without scraping human-formatted text that is free to
change between releases ([#264](https://github.com/blockchain-maxis/signet/issues/264)):

```console
$ signet link --json
{"handle":"aquawolf","publicKey":"GCEX…7QK4","network":"testnet","status":"linked"}
```

All human-facing output goes to stderr in this mode, so `stdout` stays valid
JSON even when the command is also printing progress.

---

## Exit codes

Scripts wrap this command, and an undifferentiated non-zero exit forces log
parsing. Every failure class has its own code
([#259](https://github.com/blockchain-maxis/signet/issues/259)):

| Code | Meaning                                                                      | Retryable                       |
| ---- | ---------------------------------------------------------------------------- | ------------------------------- |
| `0`  | Linked                                                                       | —                               |
| `1`  | Unexpected error                                                             | No — report it                  |
| `2`  | Configuration error (bad `--url`, unparseable config, missing/old `stellar`) | No                              |
| `3`  | No identity found                                                            | No                              |
| `4`  | Signing failed                                                               | No                              |
| `5`  | Network error reaching the deployment                                        | Yes                             |
| `6`  | Timed out waiting for approval                                               | Yes                             |
| `7`  | Approval rejected in the browser                                             | No                              |
| `8`  | Wallet already linked to another handle                                      | No                              |
| `9`  | Deployment cannot link — no database configured                              | Yes, once the operator fixes it |

Codes `5`, `6` and `9` are the only ones worth retrying automatically. `9` in
particular is not your problem to fix — see below.

---

## Linking requires a database

**A Signet deployment with no `DATABASE_URL` configured cannot link a wallet.**
Linking is refused up front rather than failing later.

### Why

A wallet link is a `Wallet` row in Postgres. There is no other place it can go.

Everything on the _read_ path degrades gracefully without a database:
`safeDbProfile` and `safeDbOperations` in
[`apps/web/lib/profiles.ts`](../apps/web/lib/profiles.ts) return `null` and the
caller falls through to a live chain read, then to the curated demo profiles.
A preview deployment with nothing provisioned still renders `/p/{handle}`.

The write path cannot do that. If linking fell through the same way, the link
would _appear_ to succeed and persist nothing: the CLI would print success, the
developer would believe they were linked, and the failure would surface later
from some unrelated command that needed the binding. **A link that silently
persists nothing is worse than a refusal.**

See [#191](https://github.com/blockchain-maxis/signet/issues/191) for database
provisioning, and [`ENVIRONMENT.md`](ENVIRONMENT.md) for `DATABASE_URL` itself.

### What you see

| Where                         | With no `DATABASE_URL`                                                   |
| ----------------------------- | ------------------------------------------------------------------------ |
| `POST /api/cli/pair/complete` | `503` with `{"error":"database_required","isConfigurationError":true,…}` |
| `GET /api/cli/pair/complete`  | `{"available":false,"reason":"database_required"}`                       |
| `/link`                       | Approval is disabled, with an explanation, **before** you approve        |
| CLI                           | Exit code `9`, naming `DATABASE_URL` — not a wallet or signature error   |

The status is **`503`, not `4xx`**: nothing about the request was wrong, and
nothing the developer does to their own account will change the outcome. The
`isConfigurationError` flag is there so a client can classify it without
string-matching a message.

`/link` checks the same signal server-side and refuses _before_ approval, so
nobody signs an approval that cannot be stored.

### Fixing it

This is for whoever operates the deployment, not for the developer trying to
link:

1. Provision Postgres and set `DATABASE_URL` for `apps/web`.
2. Apply migrations — `pnpm db:deploy` (or `pnpm db:migrate` locally).
3. Confirm with `GET /api/health`: `checks.db` should no longer report
   `"skipped"`.

`GET /api/cli/pair/complete` returning `{"available":true}` means linking can
proceed.

---

## Troubleshooting

Symptom → cause → fix, following the same shape as
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

| Symptom                                                                   | Cause                                                          | Fix                                                                                                                          |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `no identity found` (exit `3`)                                            | No `stellar` identity, or one that belongs to a different user | `stellar keys generate <name>`, or run as the user who owns the keystore — see [Choosing an identity](#choosing-an-identity) |
| `stellar: command not found` / `unknown flag: --sign-with-key` (exit `2`) | `stellar` missing or older than 25.2.0                         | Install or upgrade from the [CLI install page](https://developers.stellar.org/docs/tools/cli/install-cli)                    |
| Nothing opens; command sits at "Waiting for approval"                     | No browser — SSH, container, or headless                       | Open the printed URL manually, or pass `--no-browser`                                                                        |
| Browser shows the page, approval appears to work, CLI never returns       | [Loopback blocked](#loopback-blocked)                          | Update the CLI; check the browser console for a CORS/Private Network Access error                                            |
| `timed out waiting for approval` (exit `6`)                               | The approval window expired                                    | Re-run `signet link` and approve while it is waiting                                                                         |
| `wallet already linked` (exit `8`)                                        | That `G…` address is bound to a different handle               | Unlink from the other handle first (`signet unlink`), or link a different wallet                                             |
| `linking requires a database` (exit `9`)                                  | The **deployment** has no `DATABASE_URL`                       | Not yours to fix — see [Linking requires a database](#linking-requires-a-database)                                           |

### Loopback blocked

The approval page is served over HTTPS; the callback target is
`http://127.0.0.1:<port>`. Loopback is a potentially-trustworthy origin, so
mixed-content blocking does not apply — but Chrome sends a CORS preflight for
public → private requests and refuses the real request unless the loopback
server opts in with `Access-Control-Allow-Private-Network: true`.

An older CLI that does not answer that preflight fails **silently**: the browser
reports an opaque network error and the CLI simply waits out its timeout. It is
also invisible in local development, because `localhost → localhost` is not a
public → private transition.

**Fix:** update the CLI. If it persists, open the browser console on the
approval page — a `Private Network Access` or CORS error there confirms it, and
anything else points elsewhere. See
[#272](https://github.com/blockchain-maxis/signet/issues/272).

### Still stuck

Re-run with `--json` and include stdout, the exit code, `stellar --version`, and
your OS in an issue. Never paste a secret key or the contents of your keystore.

---

## Related docs

- [`ENVIRONMENT.md`](ENVIRONMENT.md) — every variable Signet reads
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — running your own deployment
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — first-run failures elsewhere in the project
