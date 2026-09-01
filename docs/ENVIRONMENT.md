# Environment variables

Single reference for every variable Signet reads. Copy [`.env.example`](../.env.example) to `.env` (or configure the same keys in your host) and fill values as needed.

Surfaces:

| Surface | Meaning |
| --- | --- |
| **web** | `apps/web` (Next.js — browser bundle + Node server) |
| **indexer** | `apps/indexer` long-running worker |
| **contracts CI** | GitHub Actions contract job / local `cargo` + `infra/deploy-contract.sh` (shell env, not app runtime) |

Required means “must be set for that surface to do its job in production.” Optional means the surface still starts and degrades honestly.

---

## Reference table

| Variable | Consumed by | Required / optional | Default | Behaviour when unset |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | web, indexer | **Required** for indexer. **Optional** for web. | _(none)_ | **Web:** profile/activity loaders skip Postgres and use the static manifest (and chain resolve when configured) — demo `/p/*` keeps working. The `/handles` directory falls back to discovering handles from the registry's event stream, which a public RPC serves for only ~11h (`REGISTRY_EVENT_WINDOW_LEDGERS`), so handles claimed before that are not listed. `/api/health` reports `checks.db: "skipped"`. Dashboard account writes that need Prisma return empty. **Indexer:** process refuses to start (`DATABASE_URL is required`). |
| `STELLAR_NETWORK` | _(declared for ops; not read by current TS)_ | Optional | `testnet` in `.env.example` | No runtime effect today. Prefer `NEXT_PUBLIC_STELLAR_NETWORK` (web) and `INDEXER_NETWORK` (indexer). Kept so deploy docs and local `.env` stay aligned. |
| `STELLAR_HORIZON_URL` | _(declared for ops; not read by current TS)_ | Optional | `https://horizon-testnet.stellar.org` | No runtime effect today. Indexer reads `INDEXER_HORIZON_URL` instead (same default). |
| `SOROBAN_RPC_URL` | web (server) | Optional | Falls through to `NEXT_PUBLIC_SOROBAN_RPC_URL`, then `https://soroban-testnet.stellar.org` | Server-side registry reads (`lib/chain.ts`, directory, profile chain resolve, and the `/api/health` registry check) use the public URL / testnet default. Client claim flow never sees this var (uses `NEXT_PUBLIC_SOROBAN_RPC_URL` only). |
| `NEXT_PUBLIC_APP_URL` | web | Optional locally; **set in production** | `http://localhost:3000` | `metadataBase`, sitemap, robots, tRPC base URL, and CSRF origin checks use localhost. Production origins / absolute URLs will be wrong until set to the public site URL. |
| `NEXT_PUBLIC_ROOT_DOMAIN` | web | Optional | `signet.dev` | Middleware host/handle routing treats unknown hosts against this apex. Wrong value breaks custom-domain handle routing. |
| `SIGNET_AUTH_SECRET` | web | **Required in production** (≥16 chars). Optional in development. | Dev fallback: `dev-insecure-secret-change-me` | **Production:** SIWS challenge/session code throws — auth cannot mint or verify cookies. **Development:** uses the known insecure fallback (sessions forgeable; never ship that). Generate with `openssl rand -base64 24`. |
| `NEXT_PUBLIC_STELLAR_NETWORK` | web | Optional | `testnet` | Wallet kit + claim path use Test SDF passphrase. Set `mainnet` / `public` for Public Global Stellar Network. |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | web | Optional | `https://soroban-testnet.stellar.org` | Client claim submissions and server fallback RPC target testnet. Point at your network’s Soroban RPC for non-testnet deploys. |
| `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` | web, indexer (fallback) | Optional until you deploy a registry | _(empty)_ | **Web:** claim flow disabled — UI shows the honest Phase 2 / not-configured state (`RegistryNotConfiguredError`); server chain reads skip RPC. `/api/health` reports `checks.registry: "skipped"`. **Indexer:** used only if `INDEXER_REGISTRY_CONTRACT_ID` is also empty (see below). Live testnet reference deployment: `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`. |
| `INDEXER_REGISTRY_CONTRACT_ID` | indexer | Optional | Falls back to `NEXT_PUBLIC_IDENTITY_REGISTRY_ID`, then empty | **Attestation worker no-ops** (logs `attestation.skip`, curated seed data remains source of truth for bindings). Horizon deployment/operations workers still run for wallets already in the DB. |
| `INDEXER_EVENT_WINDOW_LEDGERS` | indexer | Optional | `8000` (~11h of 5s ledgers) | On first run (no `attestation` cursor) the worker starts this many ledgers behind tip. The public RPC's actual `getEvents` span limit was found empirically at ~10,700 ledgers (~15h) — well under the ~24h its advertised retention would suggest — and it is exceeded silently: a too-large window returns a well-formed empty result, not an error. `8000` keeps real margin below that floor; see [`INDEXER.md`](INDEXER.md) §Cold start. Unset → same default. |
| `REGISTRY_CONTRACT_ID` | web (server) | Optional | Falls back to `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` | Server-only override for directory + profile chain resolve without exposing a second id to the browser. Unset → public id / empty (chain reads skipped, and `/api/health` reports `checks.registry: "skipped"`). |
| `REGISTRY_EVENT_WINDOW_LEDGERS` | web (server) | Optional | `8000` | Only used when `DATABASE_URL` is unset (or the database is unreachable): `/handles` then discovers handles by scanning this many ledgers back per request, with no persisted cursor. Same public-RPC span limit as `INDEXER_EVENT_WINDOW_LEDGERS` applies. With a database configured, the directory reads the indexer's tables instead and this has no effect. Unset → same default. |
| `SEP10_SIGNING_SECRET` | web (server) | **Required in production**. Optional in development. | Dev fallback: a random keypair per process | Stellar secret key (`S…`) of the account that signs SEP-10 challenge transactions; its public key is what `/.well-known/stellar.toml` advertises as its signing key. **Production:** `/api/auth/sep10` throws rather than sign with a throwaway key. **Development:** a fresh keypair is generated per restart, so the advertised signing key changes and previously issued challenges stop verifying. Generate with `stellar keys generate` (or any Stellar keypair tool). |
| `SEP10_WEB_AUTH_DOMAIN` | web (server) | Optional | Falls back to `NEXT_PUBLIC_ROOT_DOMAIN` | The SEP-10 `web_auth_domain` written into (and checked on) challenge transactions. Only set it when auth is served from a different host than the home domain; for single-domain deployments leave it unset. A value that doesn't match the host actually serving `/api/auth/sep10` makes every verify fail. |

---

## Degraded-but-honest modes

These are intentional product behaviour, not failures:

| Condition | What the user / operator sees |
| --- | --- |
| No `DATABASE_URL` | Web serves static (and optional on-chain) profiles. No indexer. Health: `db: skipped`, overall `ok`. |
| No registry id (`NEXT_PUBLIC_IDENTITY_REGISTRY_ID` and `REGISTRY_CONTRACT_ID` empty) | Claim button/flow disabled with an honest “not configured / Phase 2” message. No doomed RPC calls for resolve. |
| No `INDEXER_REGISTRY_CONTRACT_ID` (and no public registry fallback) | Indexer starts (if `DATABASE_URL` is set) but **attestation worker no-ops**; seed/curated bindings stay authoritative until a registry id is provided. |
| No `SIGNET_AUTH_SECRET` in production | Auth endpoints error; do not deploy web with `NODE_ENV=production` without a secret. |
| No `SEP10_SIGNING_SECRET` | **Development:** SEP-10 works, but on a per-restart random signing key — external clients that cached the signing key from `stellar.toml` must refetch it. **Production:** `/api/auth/sep10` errors; the legacy SIWS flow is unaffected. |

---

## Related variables (not in `.env.example`)

Useful when running the indexer or hardening multi-instance web:

| Variable | Consumed by | Default | Notes |
| --- | --- | --- | --- |
| `INDEXER_NETWORK` | indexer | `testnet` | Logical network label in config/logs. |
| `INDEXER_HORIZON_URL` | indexer | `https://horizon-testnet.stellar.org` | Horizon base for deployment/ops/activity workers. |
| `INDEXER_RPC_URL` | indexer | `https://soroban-testnet.stellar.org` | Soroban RPC for attestation `getEvents`. |
| `INDEXER_TICK_INTERVAL_MS` | indexer | `30000` | Main loop period. |
| `INDEXER_LOG_LEVEL` | indexer | `info` | Structured logger level. |
| `SIGNET_SESSIONS_VALID_AFTER` | web | `0` | Epoch-ms floor; sessions with `iat` below this are rejected. Global logout, for a leaked signing secret — to revoke one address or one device, use the targeted levers in [`SECURITY.md`](../SECURITY.md) instead. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | web | _(none)_ | When both set, rate limiting, **the single-use sign-in nonce store** and **the session revocation list** use Upstash; otherwise all three are in-memory per instance. On a multi-instance deploy the last two are the ones that matter: a replayed challenge routed to another instance would find a clean slate, and a revoked session would still be honoured by every instance that did not record the revocation. |
| `SIGNET_TRUSTED_PROXY_HOPS` | web | `0` | Reverse proxies in front of the app, for rate-limit IP attribution. Leave `0` on Vercel and Netlify — their edge sets a header that is detected automatically. Set it only behind your own proxy, to the number of hops appending to `X-Forwarded-For`. A value that is too high lets callers spoof their own bucket, so under-count rather than over-count; at `0` with no platform header every caller shares one bucket. See [`SECURITY.md`](../SECURITY.md). |
| `STELLAR_ACCOUNT` / `NETWORK` / `ADMIN_ADDRESS` | contracts CI / deploy script | `deployer` / `testnet` / deployer address | Shell env for `infra/deploy-contract.sh` only. |
| `DEPLOY_ENABLED` | GitHub Actions | unset | Repo **variable**; when `"true"`, `deploy.yml` runs migrations + publishes the indexer image. |
| `DATABASE_URL` (Actions secret) | contracts CI / deploy workflow | — | Production migrate job secret when `DEPLOY_ENABLED` is on. |

---

## Quick local setup

```bash
cp .env.example .env
# edit .env as needed — demo web routes need nothing beyond defaults
pnpm install
pnpm --filter @signet/web dev
```

For a full self-host (registry deploy, Netlify/Vercel, verification) see [`DEPLOYMENT.md`](./DEPLOYMENT.md).
