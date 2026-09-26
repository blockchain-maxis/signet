# @signet/indexer

Long-running worker that syncs on-chain Stellar/Soroban activity into Postgres:
wallet deployments, contract activity snapshots, Soroban invocations, and
Identity Registry `claimed`/`released` attestations. `apps/web` reads the
resulting rows (falling back to live chain and Horizon reads) to render profile
pages.

## Running

```bash
pnpm --filter @signet/indexer dev
```

Requires `DATABASE_URL` and the other env vars in [`src/config.ts`](src/config.ts)
(network, Horizon/RPC URLs, registry contract id, tick interval).

There is no seed step and no fixture data. Profiles and wallets enter the
database only from real bindings — the attestation worker (Identity Registry
events and contract state) and wallets a signed-in user links through the web
app — so a fresh database starts empty and fills as handles are claimed.
