# @signet/indexer

Long-running worker that syncs on-chain Stellar/Soroban activity into Postgres:
wallet deployments, contract activity snapshots, Soroban operations, per-contract
invocations (`ContractInvocation`), executable WASM hashes, and Identity Registry
`claimed`/`released` attestations. `apps/web` reads the resulting rows (falling
back to live chain and Horizon reads) to render profile and contract pages.

## Running

```bash
pnpm --filter @signet/indexer dev
```

Requires `DATABASE_URL` and the other env vars in [`src/config.ts`](src/config.ts)
(network, Horizon/RPC URLs, registry contract id, tick interval).

### Environment & Retention

Key variables configured in `.env` (see [`docs/ENVIRONMENT.md`](../../docs/ENVIRONMENT.md) and [`docs/RETENTION.md`](../../docs/RETENTION.md)):
- `INDEXER_CAPTURE_INVOCATIONS`: whether to capture per-contract invocations into `ContractInvocation` via RPC (default: `true`).
- `INDEXER_INVOCATIONS_MAX_PER_CONTRACT`: maximum invocation records retained per contract before pruning (default: `1000`; `0` disables).
- `INDEXER_OPERATIONS_RETENTION_DAYS`: retention window for `Operation` rows (default: `90` days).
- `INDEXER_SNAPSHOTS_RETENTION_DAYS`: retention window for `ContractSnapshot` rows (default: `30` days).
- `INDEXER_PRUNE_INTERVAL_MS`: pruning check interval in milliseconds (default: `3600000` = 1 hour).
- `INDEXER_EXECUTABLE_REFRESH_MS`: interval for checking contract WASM upgrades on-chain (default: `21600000` = 6 hours).

There is no seed step and no fixture data. Profiles and wallets enter the
database only from real bindings — the attestation worker (Identity Registry
events and contract state) and wallets a signed-in user links through the web
app — so a fresh database starts empty and fills as handles are claimed.

