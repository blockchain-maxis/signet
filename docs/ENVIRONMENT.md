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
| `DATABASE_URL` | web, indexer | **Required** for indexer. **Optional** for web. | _(none)_ | **Web:** profile/activity loaders skip Postgres and use the static manifest (and chain resolve when configured) — demo `/p/*` keeps working. `/api/health` reports `checks.db: "skipped"`. Dashboard account writes that need Prisma return empty. **Indexer:** process refuses to start (`DATABASE_URL is required`). |
| `STELLAR_NETWORK` | _(declared for ops; not read by current TS)_ | Optional | `testnet` in `.env.example` | No runtime effect today. Prefer `NEXT_PUBLIC_STELLAR_NETWORK` (web) and `INDEXER_NETWORK` (indexer). Kept so deploy docs and local `.env` stay aligned. |
| `STELLAR_HORIZON_URL` | _(declared for ops; not read by current TS)_ | Optional | `https://horizon-testnet.stellar.org` | No runtime effect today. Indexer reads `INDEXER_HORIZON_URL` instead (same default). |
| `SOROBAN_RPC_URL` | web (server) | Optional | Falls through to `NEXT_PUBLIC_SOROBAN_RPC_URL`, then `https://soroban-testnet.stellar.org` | Server-side registry reads (`lib/chain.ts`, directory, profile chain resolve) use the public URL / testnet default. Client claim flow never sees this var (uses `NEXT_PUBLIC_SOROBAN_RPC_URL` only). |
| `NEXT_PUBLIC_APP_URL` | web | Optional locally; **set in production** | `http://localhost:3000` | `metadataBase`, sitemap, robots, tRPC base URL, and CSRF origin checks use localhost. Production origins / absolute URLs will be wrong until set to the public site URL. |
| `NEXT_PUBLIC_ROOT_DOMAIN` | web | Optional | `signet.dev` | Middleware host/handle routing treats unknown hosts against this apex. Wrong value breaks custom-domain handle routing. |
| `SIGNET_AUTH_SECRET` | web | **Required in production** (≥16 chars). Optional in development. | Dev fallback: `dev-insecure-secret-change-me` | **Production:** SIWS challenge/session code throws — auth cannot mint or verify cookies. **Development:** uses the known insecure fallback (sessions forgeable; never ship that). Generate with `openssl rand -base64 24`. |
| `NEXT_PUBLIC_STELLAR_NETWORK` | web | Optional | `testnet` | Wallet kit + claim path use Test SDF passphrase. Set `mainnet` / `public` for Public Global Stellar Network. |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | web | Optional | `https://soroban-testnet.stellar.org` | Client claim submissions and server fallback RPC target testnet. Point at your network’s Soroban RPC for non-testnet deploys. |
| `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` | web, indexer (fallback) | Optional until you deploy a registry | _(empty)_ | **Web:** claim flow disabled — UI shows the honest Phase 2 / not-configured state (`RegistryNotConfiguredError`); server chain reads skip RPC. **Indexer:** used only if `INDEXER_REGISTRY_CONTRACT_ID` is also empty (see below). Live testnet reference deployment: `CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN`. |
| `INDEXER_REGISTRY_CONTRACT_ID` | indexer | Optional | Falls back to `NEXT_PUBLIC_IDENTITY_REGISTRY_ID`, then empty | **Attestation worker no-ops** (logs `attestation.skip`, curated seed data remains source of truth for bindings). Horizon deployment/operations workers still run for wallets already in the DB. |
| `INDEXER_EVENT_WINDOW_LEDGERS` | indexer | Optional | `17280` (~24h of 5s ledgers) | On first run (no `attestation` cursor) the worker starts this many ledgers behind tip. Unset → same default. |
| `REGISTRY_CONTRACT_ID` | web (server) | Optional | Falls back to `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` | Server-only override for directory + profile chain resolve without exposing a second id to the browser. Unset → public id / empty (chain reads skipped). |
| `REGISTRY_EVENT_WINDOW_LEDGERS` | web (server) | Optional | `17280` | `/handles` directory scans this many ledgers back per request (no persisted cursor). Unset → same default. |

---

## Degraded-but-honest modes

These are intentional product behaviour, not failures:

| Condition | What the user / operator sees |
| --- | --- |
| No `DATABASE_URL` | Web serves static (and optional on-chain) profiles. No indexer. Health: `db: skipped`, overall `ok`. |
| No registry id (`NEXT_PUBLIC_IDENTITY_REGISTRY_ID` and `REGISTRY_CONTRACT_ID` empty) | Claim button/flow disabled with an honest “not configured / Phase 2” message. No doomed RPC calls for resolve. |
| No `INDEXER_REGISTRY_CONTRACT_ID` (and no public registry fallback) | Indexer starts (if `DATABASE_URL` is set) but **attestation worker no-ops**; seed/curated bindings stay authoritative until a registry id is provided. |
| No `SIGNET_AUTH_SECRET` in production | Auth endpoints error; do not deploy web with `NODE_ENV=production` without a secret. |

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
| `SIGNET_SESSIONS_VALID_AFTER` | web | `0` | Epoch-ms floor; sessions with `iat` below this are rejected (global logout after secret rotation). See [`SECURITY.md`](../SECURITY.md). |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | web | _(none)_ | When both set, rate limiting can use Upstash; otherwise in-memory per instance. |
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
