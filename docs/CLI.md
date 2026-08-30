# Signet CLI

`signet link` pairs a terminal with a Signet account: the CLI opens an approval
page, you approve in the browser, and the pairing is recorded against your
account.

> **Status.** The CLI itself is in progress (#251 and the issues that follow).
> What is documented and enforced today is the one hard infrastructure
> dependency the feature has — see below.

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

| Where                         | With no `DATABASE_URL`                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/cli/pair/complete` | `503` with `{"error":"database_required","isConfigurationError":true,…}`                 |
| `GET /api/cli/pair/complete`  | `{"available":false,"reason":"database_required"}`                                       |
| `/link`                       | Approval is disabled, with an explanation, **before** you approve                        |
| CLI                           | A deployment configuration error naming `DATABASE_URL` — not a wallet or signature error |

The status is **`503`, not `4xx`**: nothing about the request was wrong, and
nothing the developer does to their own account will change the outcome. The
`isConfigurationError` flag is there so a client can classify it without
string-matching a message.

`/link` checks the same signal server-side and refuses _before_ approval,
so nobody signs an approval that cannot be stored.

### Fixing it

This is for whoever operates the deployment, not for the developer trying to
link:

1. Provision Postgres and set `DATABASE_URL` for `apps/web`.
2. Apply migrations — `pnpm db:deploy` (or `pnpm db:migrate` locally).
3. Confirm with `GET /api/health`: `checks.db` should no longer report
   `"skipped"`.

`GET /api/cli/pair/complete` returning `{"available":true}` means linking can
proceed.
