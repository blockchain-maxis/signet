# Troubleshooting — first-run failures

Symptom → cause → fix for the traps that show up when cloning Signet for the
first time. Every entry below has been reproduced on a clean checkout and the
fix verified.

If your failure is not listed, open an issue with the full command and stderr.

---

## Quick table

| Symptom                                                             | Cause                                               | Fix                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| `rpc-url is used but network passphrase is missing`                 | stellar CLI 25.2.0 `--network testnet` alias bug    | Pass `--rpc-url` and `--network-passphrase` explicitly (see below)       |
| `stellar keys generate … --fund` fails / account unfunded           | Friendbot via CLI flaky or blocked by the alias bug | Fund with Friendbot HTTP, then retry without `--fund`                    |
| `pnpm install` / Next build fails on Node 18/20                     | Engines require Node 22+                            | Upgrade Node (`nvm use` / install 22); see `.nvmrc`                      |
| `error: could not find native static library` / missing wasm target | `wasm32v1-none` not installed                       | `rustup target add wasm32v1-none`                                        |
| Web app needs Postgres?                                             | No — demo routes are static                         | Run `pnpm --filter @signet/web dev` without `DATABASE_URL`               |
| Claim button shows "Phase 2"                                        | `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` unset            | Set the deployed testnet contract id in `.env`                           |
| Indexer starts but never attests claims                             | Registry id unset                                   | Set `INDEXER_REGISTRY_CONTRACT_ID` or `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` |

---

## 1. `rpc-url is used but network passphrase is missing`

**Symptom**

```text
error: rpc-url is used but network passphrase is missing
```

when running stellar CLI commands that take `--network testnet` (key generate,
contract deploy, invoke) on **stellar CLI 25.2.0**.

**Cause**

A known alias-resolution bug: `--network testnet` does not always expand to the
full RPC URL + network passphrase pair, so the CLI sees a partial config.

**Fix**

Skip the alias. Pass both flags on every deploy/invoke:

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/identity_registry.wasm \
  --source deployer \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

Same flags apply to `stellar contract invoke` and other network calls. The
workaround is also noted in [`.env.example`](../.env.example).

**Verified:** deploy/invoke succeed with explicit flags on CLI 25.2.0 after the
alias path fails.

---

## 2. Funding a key when Friendbot via the CLI fails

**Symptom**

```bash
stellar keys generate deployer --network testnet --fund
```

errors (often the passphrase bug above), or the account exists but has **0 XLM**
so later deploys fail with insufficient balance.

**Cause**

CLI-driven Friendbot funding shares the `--network testnet` alias path and can
fail independently of key generation.

**Fix**

1. Generate without funding (add explicit network flags if needed):

   ```bash
   stellar keys generate deployer \
     --rpc-url https://soroban-testnet.stellar.org \
     --network-passphrase "Test SDF Network ; September 2015"
   ```

2. Print the address and fund via Friendbot HTTP:

   ```bash
   stellar keys address deployer
   curl "https://friendbot.stellar.org/?addr=<G...address>"
   ```

3. Confirm balance on Horizon testnet, then run
   `STELLAR_ACCOUNT=deployer NETWORK=testnet ./infra/deploy-contract.sh`.

**Verified:** Friendbot HTTP returns a successful transaction JSON; the G…
account shows a non-zero balance on `horizon-testnet.stellar.org`.

---

## 3. Build failures on Node &lt; 22

**Symptom**

- `pnpm install` warns or errors on the root `engines.node` field (`>=22`)
- Next.js 15 build/dev crashes or refuses to start on Node 18/20

**Cause**

Root [`package.json`](../package.json) pins `"node": ">=22"`. The web app and
toolchain assume Node 22 APIs.

**Fix**

```bash
node -v          # must be v22.x
# with nvm:
nvm install 22
nvm use 22
# or follow .nvmrc
pnpm install
pnpm --filter @signet/web dev
```

Fonts load via a browser-side `@import` in `globals.css` (not `next/font`), so
once Node is correct the build should not block on font downloads.

**Verified:** `pnpm --filter @signet/web dev` serves `/` on Node 22; Node 20
trips the engines check.

---

## 4. `wasm32v1-none` target missing

**Symptom**

```text
error: could not find target `wasm32v1-none`
```

or cargo build fails looking for the wasm target when building
`packages/contracts`.

**Cause**

Rust stable is installed, but the Soroban wasm target is optional and not
added by default.

**Fix**

```bash
rustup target add wasm32v1-none
cd packages/contracts
cargo test
cargo build --target wasm32v1-none --release
```

See [`packages/contracts/README.md`](../packages/contracts/README.md).

**Verified:** `cargo build --target wasm32v1-none --release` produces
`identity_registry.wasm` after the target is added.

---

## 5. Running the web app with no `DATABASE_URL`

**Symptom**

Uncertainty whether Postgres must be running; fear that `/p/{handle}` will 500
without a database.

**Cause**

The indexer and Prisma paths need `DATABASE_URL`, but the canonical demo
profiles do **not**. `apps/web/lib/profiles.ts` falls back to
`apps/web/public/data/*.json` whenever the DB is unset or unreachable
(`safeDbProfile` / `safeDbOperations`).

**Fix**

```bash
# No .env and no Docker required for demos:
pnpm install
pnpm --filter @signet/web dev
# open http://localhost:3000/p/aquawolf
```

Only set `DATABASE_URL` (and run `pnpm db:up` + `pnpm db:migrate`) when you
want the indexer or DB-backed reads. Leave it unset for pure UI work.

**Verified:** with `DATABASE_URL` unset, `/`, `/how-it-works`, and
`/p/aquawolf` render from static fixtures.

---

## 6. Claim button shows the Phase 2 message

**Symptom**

"Connect wallet" / "Claim your handle" surfaces an honest **Phase 2** message
instead of submitting an on-chain claim.

**Cause**

`apps/web/lib/registry.ts` reads `NEXT_PUBLIC_IDENTITY_REGISTRY_ID`. When empty,
the UI refuses to pretend the registry is live.

**Fix**

1. Copy [`.env.example`](../.env.example) to `.env` (or `.env.local` for Next).
2. Set the deployed testnet id (also commented in `.env.example`):

   ```bash
   NEXT_PUBLIC_IDENTITY_REGISTRY_ID=CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
   ```

3. Restart the web dev server (`NEXT_PUBLIC_*` is inlined at boot).

If you deploy your own registry, put that contract id in the same variable
instead. Until it is set, the Phase 2 message is intentional, not a bug.

**Verified:** unset → Phase 2 copy; set to the testnet id → claim path attempts
a real registry call via Soroban RPC.

---

## 7. Indexer starting with no registry id

**Symptom**

Indexer process runs and ticks, but no claim/release bindings appear in the DB;
logs show `attestation.skip — no registry contract configured` at debug level.

**Cause**

`runAttestationWorker` no-ops when
`INDEXER_REGISTRY_CONTRACT_ID` and `NEXT_PUBLIC_IDENTITY_REGISTRY_ID` are both
empty (`apps/indexer/src/workers/attestation.ts`). Curated seed data remains the
source of truth for handles.

**Fix**

```bash
# .env for the indexer process
DATABASE_URL=postgresql://signet:signet@localhost:5432/signet
INDEXER_REGISTRY_CONTRACT_ID=CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
# or rely on fallback:
# NEXT_PUBLIC_IDENTITY_REGISTRY_ID=CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN

pnpm db:up
pnpm db:migrate
pnpm indexer:dev
```

Without a registry id the Horizon workers can still run for seeded wallets;
only attestation ingest is skipped. That is safe degraded mode, not a crash.

**Verified:** empty registry id → debug skip, process stays up; with id set →
attestation worker queries Soroban events for that contract.

---

## 8. Profile 404s or shows archived after ~30 days of inactivity

**Symptom**

A previously claimed handle appears unavailable or displays an archival banner indicating its persistent entry has expired.

**Cause**

Soroban smart contracts enforce a Time-To-Live (TTL) of ~30 days on persistent storage entries. If a handle is not queried or modified within that window, its entry moves into cold archived storage.

**Fix**

Restore the binding footprint via the web app or Stellar CLI, or run the keep-alive sweep script:

```bash
# Keep-alive sweep to bump active bindings
node scripts/keepalive-contract.mjs

# Detailed runbook:
# See docs/ARCHIVAL_AND_RESTORATION.md
```

See [`docs/ARCHIVAL_AND_RESTORATION.md`](ARCHIVAL_AND_RESTORATION.md) for full restoration procedures.

---

## Related docs

- [README — Run locally](../README.md#run-locally)
- [`.env.example`](../.env.example)
- [`docs/ARCHIVAL_AND_RESTORATION.md`](ARCHIVAL_AND_RESTORATION.md)
- [`packages/contracts/README.md`](../packages/contracts/README.md)
- [`infra/README.md`](../infra/README.md)
