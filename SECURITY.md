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
  the app refuses the dev fallback when `NODE_ENV=production`. Rotate it (and
  bump `SIGNET_SESSIONS_VALID_AFTER`, see below) to revoke all sessions.
- **`SIGNET_SESSIONS_VALID_AFTER`** invalidates any session whose `iat`
  (issued-at) claim is older than this value. Set it to an
  [ISO 8601](https://en.wikipedia.org/wiki/ISO_8601) timestamp to force all
  existing sessions to be re-authenticated. This is the mechanism for
  bulk-revoking sessions after a credential rotation or security incident.

  ```bash
  # Revoke all sessions created before now
  SIGNET_SESSIONS_VALID_AFTER=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  ```

  A good practice is to set this value to **the moment you rotate
  `SIGNET_AUTH_SECRET`**, so that old-credential-issued sessions are rejected
  immediately. The env var applies server-side and is read on each request.
- The default rate limiter is per-instance; back it with a shared store
  (`setRateLimitStore`) for multi-instance deployments.
- Security headers (CSP, HSTS, …) are set in `apps/web/next.config.js`. The CSP
  still allows inline scripts for Next's bootstrap — tighten to nonce-based when
  feasible.
- The Identity Registry contract is **immutable** (no upgrade path) and uses a
  single admin key — use a multisig for the admin and audit before mainnet.
