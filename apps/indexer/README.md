# @signet/indexer

Long-running worker that syncs on-chain Stellar/Soroban activity into Postgres:
wallet deployments, contract activity snapshots, Soroban invocations, and
Identity Registry `claimed`/`released` attestations. `apps/web` reads the
resulting rows (with a static-data fallback) to render profile pages.

## Running

```bash
pnpm --filter @signet/indexer dev
```

Requires `DATABASE_URL` and the other env vars in [`src/config.ts`](src/config.ts)
(network, Horizon/RPC URLs, registry contract id, tick interval).

## Seeding demo data

```bash
pnpm indexer:seed
```

This runs the indexer once with `--reseed`, which upserts the curated demo
profiles from [`src/seed-data.ts`](src/seed-data.ts) (`aquawolf`, `sorobuilder`,
`stellardev`) and their wallets into the database.

Use it to populate a fresh local database, or to restore the curated profiles
after on-chain attestations (`src/workers/attestation.ts`) have overwritten
them during Phase 2 testing.

Without `--reseed`, seeding only runs automatically on a database that has no
indexer cursor yet (i.e. the very first run). `--reseed` forces it to run
again on top of an existing database.

**Idempotent by design:** every write is a Prisma `upsert` keyed on
`profile.handle` / `wallet.pubkey`, so running `pnpm indexer:seed` any number
of times converges on the same rows instead of creating duplicates or
resetting unrelated data (e.g. on-chain attestations bound to other handles).
This is covered by [`src/workers/seed.test.ts`](src/workers/seed.test.ts), which
runs the seed worker twice against an in-memory store and asserts the
resulting state is identical.
