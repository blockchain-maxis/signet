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

- **`SIGNET_SESSIONS_VALID_AFTER`** — set this to a Unix epoch timestamp in
  milliseconds to reject all sessions **issued before** that moment. Use it
  right after rotating `SIGNET_AUTH_SECRET` (or after a suspected leak) to
  force every existing session to be re-authenticated. The variable is checked
  on every request, so no restart is needed.
  
  Copy-paste command to revoke all sessions right now:
  
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
- The Identity Registry contract is **immutable** (no upgrade path) and uses a
  single admin key — use a multisig for the admin and audit before mainnet.
