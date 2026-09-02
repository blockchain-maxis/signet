# Self-hosting Signet

End-to-end guide: clone → deploy your own Identity Registry on Stellar testnet →
host the web app → verify. Commands are copy-pasteable. Env var semantics live in
[`ENVIRONMENT.md`](./ENVIRONMENT.md).

---

## 1. Prerequisites

| Tool | Version / notes |
| --- | --- |
| Node.js | **22+** (see `.nvmrc`) |
| pnpm | **9+** (`packageManager` in root `package.json`) |
| Rust | stable toolchain |
| wasm target | `wasm32v1-none` |
| Stellar CLI | [Install](https://developers.stellar.org/docs/tools/cli) (`stellar` on `PATH`) |
| Docker | Optional — local Postgres via `pnpm db:up` |
| Git | — |

```bash
# Node
node -v    # v22.x or newer
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm -v    # 9.x

# Rust + Soroban wasm target
rustup update stable
rustup target add wasm32v1-none
rustc -V
cargo -V

# Stellar CLI
stellar --version

# Clone and install
git clone https://github.com/blockchain-maxis/signet.git
cd signet
pnpm install
```

---

## 2. Generate and fund a deploy key

Use a clearly named key per environment. Each key is its own Stellar account.

```bash
# Creates identity "deployer" and requests Friendbot funding on testnet
stellar keys generate deployer --network testnet --fund

# Print the G… address (you will need it for initialize and Friendbot)
stellar keys address deployer
```

### Friendbot / CLI workaround (stellar CLI 25.2.0)

If `keys generate … --fund` or later commands fail with
`rpc-url is used but network passphrase is missing` (known `--network testnet`
alias resolution bug on some CLI builds):

```bash
# 1. Ensure the key exists without --fund if needed
stellar keys generate deployer

# 2. Fund manually
ADDR="$(stellar keys address deployer)"
curl "https://friendbot.stellar.org/?addr=${ADDR}"

# 3. Prefer explicit RPC + passphrase instead of --network testnet on
#    deploy/invoke (see section 5 fallback), or fix your CLI network config:
stellar network add testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --horizon-url https://horizon-testnet.stellar.org
```

---

## 3. Build the wasm

```bash
cargo build \
  --manifest-path packages/contracts/Cargo.toml \
  --target wasm32v1-none \
  --release

# Optional size check (CI budget is 20 KB)
ls -la packages/contracts/target/wasm32v1-none/release/identity_registry.wasm
```

Unit tests (optional but recommended before deploy):

```bash
cargo test --manifest-path packages/contracts/Cargo.toml
```

---

## 4. Deploy with `infra/deploy-contract.sh`

The script builds (again), optimizes when possible, deploys, and calls
`initialize(admin)`.

```bash
chmod +x infra/deploy-contract.sh

STELLAR_ACCOUNT=deployer NETWORK=testnet ./infra/deploy-contract.sh
```

Override the admin (defaults to the deployer address):

```bash
ADMIN_ADDRESS="$(stellar keys address deployer)" \
STELLAR_ACCOUNT=deployer \
NETWORK=testnet \
./infra/deploy-contract.sh
```

### Capture the contract id

On success the script prints:

```text
NEXT_PUBLIC_IDENTITY_REGISTRY_ID=C…
INDEXER_REGISTRY_CONTRACT_ID=C…
```

Save the `C…` value. You will set both env vars (web + indexer) to that id.

**Reference testnet deployment** (maintainer-operated, 2026-07-09, admin alias
`signet`):

```text
CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
```

Use this only if you intentionally point at the shared demo registry rather than
your own.

---

## 5. Manual deploy + `initialize` (script alternative)

If the script is unavailable or the CLI network alias is broken:

```bash
WASM=packages/contracts/target/wasm32v1-none/release/identity_registry.wasm
ACCOUNT=deployer
RPC=https://soroban-testnet.stellar.org
PASS="Test SDF Network ; September 2015"

# Optimize when the subcommand exists (ignore failure)
stellar contract optimize --wasm "$WASM" || true

CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" \
  --source "$ACCOUNT" \
  --rpc-url "$RPC" \
  --network-passphrase "$PASS")"
echo "contract id: $CONTRACT_ID"

ADMIN="$(stellar keys address "$ACCOUNT")"

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ACCOUNT" \
  --rpc-url "$RPC" \
  --network-passphrase "$PASS" \
  -- initialize --admin "$ADMIN"
```

Confirm with a read:

```bash
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ACCOUNT" \
  --rpc-url "$RPC" \
  --network-passphrase "$PASS" \
  -- count
# → 0 on a fresh registry
```

---

## 6. Configure the web app

```bash
cp .env.example .env
```

Minimum production-oriented `.env` (replace placeholders):

```bash
NEXT_PUBLIC_APP_URL=https://your-domain.example
NEXT_PUBLIC_ROOT_DOMAIN=your-domain.example
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_IDENTITY_REGISTRY_ID=C…your-contract-id…
SIGNET_AUTH_SECRET=   # openssl rand -base64 24  — required in production (≥16 chars)

# Optional: Postgres for DB-backed profiles + indexer
# DATABASE_URL=postgresql://user:pass@host:5432/signet

# Optional: indexer attestation (same id as the web registry)
# INDEXER_REGISTRY_CONTRACT_ID=C…your-contract-id…
```

Generate the auth secret:

```bash
openssl rand -base64 24
```

Local smoke without hosting:

```bash
pnpm --filter @signet/web dev
# open http://localhost:3000
```

---

## 7. Deploy the web app

The app is a Next.js monorepo package at `apps/web`. Root
[`netlify.toml`](../netlify.toml) builds with Turborepo.

### 7a. Netlify

1. Create a new site from this Git repo (or `netlify init` with the Netlify CLI).
2. Build settings are already in `netlify.toml`:

   ```toml
   [build]
       base = "."
       command = "pnpm install --frozen-lockfile && pnpm turbo run build --filter=./apps/web"
       publish = "apps/web/.next"
   ```

3. If the UI plugin requires an explicit Next runtime, enable **Netlify Next.js
   Runtime** / `@netlify/plugin-nextjs` for the site so App Router API routes work.
4. Site settings → Environment variables — set at least:

   | Variable | Example |
   | --- | --- |
   | `NEXT_PUBLIC_APP_URL` | `https://<site>.netlify.app` |
   | `NEXT_PUBLIC_ROOT_DOMAIN` | `<site>.netlify.app` (or your custom domain) |
   | `NEXT_PUBLIC_STELLAR_NETWORK` | `testnet` |
   | `NEXT_PUBLIC_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
   | `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` | `C…` from section 4 |
   | `SIGNET_AUTH_SECRET` | output of `openssl rand -base64 24` |
   | `DATABASE_URL` | optional managed Postgres URL |

5. Trigger a production deploy. Confirm the build log finishes
   `turbo run build --filter=./apps/web` without errors.

CLI sketch:

```bash
# requires: npm i -g netlify-cli && netlify login
netlify link
netlify env:set NEXT_PUBLIC_APP_URL "https://your-site.netlify.app"
netlify env:set NEXT_PUBLIC_ROOT_DOMAIN "your-site.netlify.app"
netlify env:set NEXT_PUBLIC_STELLAR_NETWORK "testnet"
netlify env:set NEXT_PUBLIC_SOROBAN_RPC_URL "https://soroban-testnet.stellar.org"
netlify env:set NEXT_PUBLIC_IDENTITY_REGISTRY_ID "C…"
netlify env:set SIGNET_AUTH_SECRET "$(openssl rand -base64 24)"
netlify deploy --prod --build
```

### 7b. Vercel

1. Import the Git repo in Vercel.
2. Framework preset: **Next.js**. Root directory: repository root (not `apps/web`).
3. Install command: `pnpm install --frozen-lockfile`
4. Build command: `pnpm turbo run build --filter=./apps/web`
5. Output: Next.js default (Vercel detects the app via the turbo filter / workspace).
6. Add the same production env vars as Netlify, including **`SIGNET_AUTH_SECRET`**.
7. Deploy.

CLI sketch:

```bash
# requires: npm i -g vercel && vercel login
vercel link
vercel env add NEXT_PUBLIC_APP_URL production
vercel env add NEXT_PUBLIC_ROOT_DOMAIN production
vercel env add NEXT_PUBLIC_STELLAR_NETWORK production
vercel env add NEXT_PUBLIC_SOROBAN_RPC_URL production
vercel env add NEXT_PUBLIC_IDENTITY_REGISTRY_ID production
vercel env add SIGNET_AUTH_SECRET production
vercel --prod
```

### Optional: Postgres + indexer

```bash
# Local DB
pnpm db:up
pnpm db:deploy

# Indexer (requires DATABASE_URL + optional INDEXER_REGISTRY_CONTRACT_ID)
pnpm indexer:dev
```

Production indexer image (from repo root, after `DEPLOY_ENABLED` / secrets are
wired — see `.github/workflows/deploy.yml`):

```bash
docker build -f apps/indexer/Dockerfile -t signet-indexer .
docker run --rm -e DATABASE_URL -e INDEXER_REGISTRY_CONTRACT_ID signet-indexer
```

---

## 8. Post-deploy verification checklist

Replace `BASE` with your public origin (no trailing slash).

```bash
BASE=https://your-domain.example

# Marketing + demo profiles (expect HTTP 200)
curl -sS -o /dev/null -w "%{http_code}\n" "$BASE/"
curl -sS -o /dev/null -w "%{http_code}\n" "$BASE/p/aquawolf"
curl -sS -o /dev/null -w "%{http_code}\n" "$BASE/how-it-works"

# Health probe — expect JSON status "ok". Each dependency is reported
# separately under `checks`; an unconfigured one reads "skipped".
curl -sS "$BASE/api/health"
```

| Check | Pass criteria |
| --- | --- |
| `GET /` | HTTP 200, landing HTML |
| `GET /p/aquawolf` | HTTP 200, demo profile renders |
| `GET /how-it-works` | HTTP 200 |
| `GET /api/health` | JSON `status` is `ok`. `degraded` means a configured dependency is down — read `checks.db` (Postgres) and `checks.registry` (Soroban RPC + registry contract) to see which |
| Claim lands on-chain | With `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` set: connect a funded testnet wallet, claim an unused handle, then `resolve` returns the G… address (below) |
| Claim disabled honestly | With registry id **unset**: UI says the deployment is not configured, not a hard crash |

On-chain claim verification (testnet):

```bash
CONTRACT_ID=C…your-id…
HANDLE=yourtesthandle   # [a-z0-9_-]{1,32}, unused
RPC=https://soroban-testnet.stellar.org
PASS="Test SDF Network ; September 2015"
ACCOUNT=deployer        # or the wallet that signed the claim in the UI

# After a successful UI claim (wallet must authorize claim):
stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$ACCOUNT" \
  --rpc-url "$RPC" \
  --network-passphrase "$PASS" \
  -- resolve --handle "$HANDLE"
# → G… address of the claiming wallet
```

---

## 9. Rollback

| Layer | Rollback |
| --- | --- |
| **Web (Netlify / Vercel)** | Redeploy the previous successful deploy from the host UI (Netlify Deploys → Publish deploy / Vercel Deployments → Promote). Instant traffic switch; no chain interaction. |
| **Env misconfiguration** | Revert bad env vars in the host, then redeploy or restart so Next picks up `NEXT_PUBLIC_*` at build time. Server-only secrets (`SIGNET_AUTH_SECRET`, `DATABASE_URL`) apply on the next instance boot. |
| **Auth secret leak** | Set a new `SIGNET_AUTH_SECRET` and set `SIGNET_SESSIONS_VALID_AFTER` to current epoch-ms to invalidate old cookies (see [`SECURITY.md`](../SECURITY.md)). |
| **One compromised wallet** | `pnpm --filter @signet/web run revoke:sessions -- G…` revokes that address' sessions only; running instances honour it within ten seconds. Do **not** reach for `SIGNET_SESSIONS_VALID_AFTER`, which signs out every user (see [`SECURITY.md`](../SECURITY.md)). |
| **Identity Registry** | The contract is **immutable** (no upgrade path). You cannot patch wasm in place. Deploy a new contract id, point `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` / `INDEXER_REGISTRY_CONTRACT_ID` at it, and redeploy web + restart indexer. Old bindings stay on the old contract unless users re-claim. Do not improvise this: [`CONTRACT_MIGRATION.md`](CONTRACT_MIGRATION.md) has the full runbook — when a migration is and is not the answer, how the binding set is reconstructed, the cutover order (including resetting the attestation cursor), and what users have to do. Prefer a fresh testnet deploy over trying to “fix” production wasm. |
| **Indexer / DB** | Stop the worker; restore Postgres from backup if migrations or data are bad; run `pnpm db:deploy` only forward. Image tags include git SHA via `deploy.yml` for pin-and-revert. |

---

## 10. Going to mainnet

Everything above targets **testnet**. `infra/deploy-contract.sh` is
network-agnostic, so `NETWORK=mainnet ./infra/deploy-contract.sh` works
mechanically — but mainnet moves **real value and real reputation**, and the
Identity Registry is immutable, so clear these gates first.

> **Two hard gates before any mainnet deploy** (see [`SECURITY.md`](../SECURITY.md)):
>
> 1. **Audit the contract.** The Identity Registry has not been through a
>    third-party security audit, and it is **immutable** — a bug shipped to
>    mainnet cannot be patched in place. That audit is a hard prerequisite for
>    mainnet, not a nice-to-have.
> 2. **Rotate the admin to a multisig.** `initialize` sets a single admin key
>    (the deployer by default). Before going live, move moderation authority to a
>    multisig Stellar account with `set_admin`, so no single key can be lost or
>    compromised. See
>    [`packages/contracts/identity-registry/README.md`](../packages/contracts/identity-registry/README.md).

### 10a. Mainnet environment values

The same variables as testnet (section 6), pointed at the public network. Note
there is **no public mainnet Soroban RPC** — it is a paid/self-hosted provider,
so `NEXT_PUBLIC_SOROBAN_RPC_URL` is your provider endpoint, not an SDF host.

| Variable | Mainnet value |
| --- | --- |
| `NEXT_PUBLIC_STELLAR_NETWORK` | `mainnet` |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` / `SOROBAN_RPC_URL` | your paid provider URL (QuickNode, Blockdaemon, Validation Cloud, self-hosted — no public host) |
| `NEXT_PUBLIC_HORIZON_URL` / `HORIZON_URL` | `https://horizon.stellar.org` |
| `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` / `INDEXER_REGISTRY_CONTRACT_ID` | `C…` from the mainnet deploy below |
| network passphrase (CLI) | `Public Global Stellar Network ; September 2015` |

The indexer equivalents (`INDEXER_NETWORK=mainnet`, `INDEXER_RPC_URL`,
`INDEXER_HORIZON_URL`) take the same values.

### 10b. Deploy to mainnet

The deploy key must be a **real, funded** account — mainnet has no Friendbot, so
buy and transfer XLM to cover the deploy + `initialize` fees. Then:

```bash
STELLAR_ACCOUNT=deployer NETWORK=mainnet ./infra/deploy-contract.sh
```

Manual variant (mirrors section 5 with the mainnet RPC + passphrase):

```bash
WASM=packages/contracts/target/wasm32v1-none/release/identity_registry.wasm
ACCOUNT=deployer
RPC=https://your-mainnet-rpc-provider.example   # your paid provider — no public host
PASS="Public Global Stellar Network ; September 2015"

CONTRACT_ID="$(stellar contract deploy \
  --wasm "$WASM" --source "$ACCOUNT" \
  --rpc-url "$RPC" --network-passphrase "$PASS")"

stellar contract invoke --id "$CONTRACT_ID" --source "$ACCOUNT" \
  --rpc-url "$RPC" --network-passphrase "$PASS" \
  -- initialize --admin "$(stellar keys address "$ACCOUNT")"
```

### 10c. Rotate the admin to a multisig

Once the deploy is verified, hand moderation authority to a multisig account (the
current admin must authorize the call):

```bash
stellar contract invoke --id "$CONTRACT_ID" --source "$ACCOUNT" \
  --rpc-url "$RPC" --network-passphrase "$PASS" \
  -- set_admin --new_admin G…your-multisig-address…
```

### 10d. Rollback on mainnet

The rollback matrix in section 9 applies, with one caveat sharpened by real
value: the Identity Registry is **immutable on mainnet too**. "Deploy a new
contract id" strands every **real** handle→wallet binding on the old contract —
users must re-claim on the new one — and there is no in-place fix. This is
exactly why the audit and multisig gates above are non-negotiable: on mainnet you
cannot deploy your way out of a contract bug or a lost admin key.

---

## 11. Related docs

| Doc | Purpose |
| --- | --- |
| [`ENVIRONMENT.md`](./ENVIRONMENT.md) | Every env var: consumer, required/optional, default, unset behaviour |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | Data flows and deployed vs operational-only |
| [`SECURITY.md`](../SECURITY.md) | Operator hardening (secrets, sessions, CSP) |
| [`infra/README.md`](../infra/README.md) | Local Postgres |
| [`packages/contracts/identity-registry/README.md`](../packages/contracts/identity-registry/README.md) | Contract interface |

---

## 11. Keeping the instance alive (and restoring it after archival)

The registry's admin address and handle counter live in **instance storage**,
which archives when its TTL lapses — and an archived instance fails **every**
entry point, `claim` included, so the contract cannot bootstrap itself back
into liveness through normal use. The bindings themselves live in persistent
storage with independent TTLs and stay perfectly alive; the registry merely
*looks* bricked until someone restores the instance.

Every **invoked** call — writes, and since the read-bump change also `resolve`,
`lookup`, `is_bound`, `count` and `resolve_batch` — extends the instance TTL by
roughly 30 days. Two sharp edges remain:

- **Simulated reads extend nothing.** The web app's registry reads are view
  simulations, whose footprints are discarded. A deployment whose only chain
  traffic is the website reading it is, from the instance's point of view,
  silent.
- **Deployments predating the read-bump** (including the pinned testnet
  registry) extend only on writes — a quiet month with no claims is enough to
  archive them, and claim volume is lowest exactly when a registry is newest.

### Keep-alive

Run a TTL extension on a schedule (monthly is comfortable against a ~30-day
window). It is a host operation — it works the same for any deployed wasm and
costs a normal fee:

```bash
stellar contract extend   --id "$CONTRACT_ID"   --ledgers-to-extend 518400   --source "$ACCOUNT"   --rpc-url "$RPC"   --network-passphrase "$PASS"
# 518400 ledgers ≈ 30 days at ~5s/ledger — the same window the contract's own
# bumps use.
```

Any invoked read works as a lighter-weight alternative on current wasm (the
`count` invocation from section 5 doubles as a keep-alive), but `extend` is the
version that never depends on which wasm is deployed.

### Restoring an archived instance

If the instance has already archived (calls fail with an archived/expired
entry error, while `resolve` simulations may still show bindings):

```bash
stellar contract restore   --id "$CONTRACT_ID"   --source "$ACCOUNT"   --rpc-url "$RPC"   --network-passphrase "$PASS"
```

Then immediately run the keep-alive `extend` above — restoration brings the
entry back at the minimum TTL, not a comfortable one. Bindings whose own
persistent entries archived are a separate matter: restoring the instance does
not resurrect them, and a binding nobody has touched in ~30 days needs its own
`restore` with the specific storage key before it resolves again.
