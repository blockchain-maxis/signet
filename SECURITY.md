# Security Policy

## Reporting a vulnerability

Please report security issues privately. **Do not open a public issue.**

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) on this repository, or
- email the maintainers (see the repository owner profile).

We aim to acknowledge reports within 3 business days and to ship a fix or
mitigation for confirmed high-severity issues within 30 days.

## Scope

- The `identity-registry` Soroban contract (`packages/contracts/`)
- The web application and its API (`apps/web/`)
- The indexer (`apps/indexer/`)

## Hardening notes for operators

- **`SIGNET_AUTH_SECRET`** must be set (≥16 random chars) in production —
  the app refuses the dev fallback when `NODE_ENV=production`. Rotate it to
  invalidate sessions going forward.

### Revoking sessions

Sessions are stateless HMAC cookies with a seven-day lifetime, so revocation is
an explicit act. Three levers, narrowest first — reach for the global one only
when the thing that leaked is global.

**One session.** `POST /api/auth/logout` revokes the session id it is signing
out, so a cookie copied off the device before sign-out stops working too. An
operator can revoke a session id directly:

```bash
pnpm --filter @signet/web run revoke:sessions -- --session <session id>
```

**One address.** The response to a single compromised wallet:

```bash
pnpm --filter @signet/web run revoke:sessions -- GABC…
```

Every session for that address stops working; every other user is unaffected.
The wallet can sign in again immediately — this is a revocation, not a ban.
Users can do the same for themselves from **Settings → Other devices**, which
signs out every device except the one they are on
(`POST /api/auth/revoke {"scope":"others"}`, or `{"scope":"all"}` to include
the current one).

Both are recorded in the shared store (see `UPSTASH_REDIS_REST_URL` below) and
picked up by running instances within ten seconds — no restart, no redeploy, no
env change. Each instance caches the whole list in memory and refreshes it on
that interval, so this adds no per-request round trip. If the store cannot be
read, the last known list is used for up to a minute and after that **every**
session is rejected: an unreadable revocation list must not silently mean
"nobody is revoked".

> Without `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` the list is
> per-instance, which is correct on a single long-lived server and wrong on a
> multi-replica or serverless deploy — a revocation would bind only on the
> instance that recorded it. Set them there. The CLI refuses to run without
> them rather than reporting a revocation the app never sees.

**Everyone.** **`SIGNET_SESSIONS_VALID_AFTER`** — set this to a Unix epoch
timestamp in milliseconds to reject all sessions **issued before** that moment.
This is the right lever for exactly one situation: `SIGNET_AUTH_SECRET` leaked
or was rotated, so every session really is suspect. The variable is checked on
every request, so no restart is needed.

  ```bash
  export SIGNET_SESSIONS_VALID_AFTER=$(node -e "console.log(Date.now())")
  ```

  For Docker Compose deployments, set the variable in your environment or
  `.env` file and recreate the containers:

  ```bash
  SIGNET_SESSIONS_VALID_AFTER=$(node -e "console.log(Date.now())") docker compose up -d --force-recreate
  ```
- The default rate limiter is per-instance; back it with a shared store
  (`setRateLimitStore`) for multi-instance deployments.
- Security headers (HSTS, …) are set in `apps/web/next.config.js`; the CSP is
  built per request in `apps/web/middleware.ts` so `script-src` carries a fresh
  nonce instead of `'unsafe-inline'`.

- **CSP violation reporting.** The policy points `report-uri` and `report-to`
  at `POST /api/csp-report`, which logs every violation as a structured
  `csp.violation` line. A blocked request is otherwise invisible — the page
  just renders with something missing — so watch that event after any policy
  change, and alert on it if you have a log pipeline. To send reports to an
  external collector instead, pass its URL as `reportUri` to `buildCsp` in the
  middleware.
- **Deploy wallet attachment is refusal-first.** A deploy account already
  bound to one profile is never moved to another, even by a caller holding the
  key and a valid signed challenge — proving control of a key is not proof of
  which profile should hold it. The holder releases it from **Wallets** first.
  The full policy, the release path, and why the refusal text names no profile
  are in [`docs/WALLET_ATTACHMENT.md`](docs/WALLET_ATTACHMENT.md).
- The Identity Registry contract is **immutable** (no upgrade path) and uses a
  single admin key — use a multisig for the admin and audit before mainnet.
  A defect found after deployment cannot be patched; recovery is a new contract
  and a coordinated cutover, written up in advance in
  [`docs/CONTRACT_MIGRATION.md`](docs/CONTRACT_MIGRATION.md). One of its
  preconditions — keeping binding snapshots, because Soroban RPC's event window
  is measured in hours — has to be in place **before** an incident, not during
  one.
