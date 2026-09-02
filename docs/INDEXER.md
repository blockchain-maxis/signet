# Indexer operator runbook

`apps/indexer` is a single long-running Node process that keeps the Signet database in
sync with Stellar. It has no HTTP surface and no scheduler: it loops forever, and each
pass through the loop (a **tick**) runs every worker in a fixed order, then sleeps
`INDEXER_TICK_INTERVAL_MS` (default 30 s).

This document is for whoever has to answer "is it healthy", "where did it stop" and "how
do I restart it safely". For the data model see [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma);
for how the indexer fits the rest of the system see [`ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## 1. Workers

Entry point: [`apps/indexer/src/index.ts`](../apps/indexer/src/index.ts). Workers run
sequentially inside one tick, in this order. A worker that throws is caught per worker
(deployment/activity/operations catch per wallet or per contract); anything that escapes
is caught by the tick, logged as `tick.error`, and the loop continues.

| # | Worker | Runs | Input | Writes |
|---|--------|------|-------|--------|
| 0 | **seed** | Once at startup, only when the `main` cursor row is missing or `--reseed` was passed | the hard-coded list in [`src/seed-data.ts`](../apps/indexer/src/seed-data.ts) | `Profile`, `Wallet` (`source: 'curated'`) |
| 1 | **attestation** | Every tick, **skipped entirely** when no registry contract id is configured | Soroban RPC `getEvents` on the Identity Registry | `Profile`, `Wallet` (`source: 'onchain'`), cursor `attestation` |
| 2 | **deployment** | Every tick | Horizon `/accounts/{pubkey}/operations` for every `Wallet` row (200 most recent, desc), plus a transaction fetch per contract-creation op | `Contract` |
| 3 | **activity** | Every tick | Horizon `/accounts/{contract}/transactions` for every `Contract` whose newest snapshot is older than 5 min | `ContractSnapshot` |
| 4 | **operations** | Every tick | Horizon `/accounts/{pubkey}/operations` for every `Wallet` (50 most recent, desc) | `Operation` |

Notes that matter in production:

- **Cadence is per tick, not per worker.** There is no independent scheduling — a slow
  Horizon makes every worker late. The only intra-tick throttle is a fixed 100 ms sleep
  between Horizon calls in the deployment, activity and operations workers.
- **The activity worker has its own freshness gate**: a contract is re-snapshotted only
  when its latest `ContractSnapshot` is older than **5 minutes**, so `snapshotsWritten: 0`
  on a tick is normal, not a fault.
- **Everything is idempotent.** All writes are `upsert`s keyed on a natural id
  (`Profile.handle`, `Wallet.pubkey`, `Contract.address`, `Operation.id` = the Horizon
  operation id). Re-running over the same ledger range cannot duplicate rows.
- **`released` / `revoked` events delete the `Wallet` row**, which cascades to that
  wallet's `Contract`, `Operation` and snapshot rows. The `Profile` row survives.

### The registry event contract

The attestation worker decodes events shaped as:

```
topics = [ symbol("claimed" | "released" | "revoked"), string(handle) ]
data   = address(wallet)
```

Anything else is skipped silently. See the
[identity-registry README](../packages/contracts/identity-registry/README.md) for the
contract's own method and event reference.

---

## 2. Cursors and resumption

Cursors live in the `IndexerCursor` table — one row per cursor, `id` is the name:

| Cursor id | Written by | Value | Used for |
|-----------|-----------|-------|----------|
| `main` | end of each tick, **only if** the deployment worker saw a ledger > 0 | highest ledger sequence observed while scanning wallet operations | Only as a "have we ever run" flag — it decides whether the seed worker runs at startup. **It is not a resume point**; the deployment worker always rescans the most recent 200 operations per wallet. |
| `attestation` | end of the attestation worker, whenever the RPC call succeeded | `latestLedger` reported by the last `getEvents` response | The real resume point. Next tick reads from `lastLedger + 1`. |

Consequences worth knowing before an incident:

- **The attestation cursor is the only thing that must not be lost.** Delete it and the
  worker cold-starts (see below); set it too high and it stalls (see troubleshooting).
- It is advanced to the RPC's `latestLedger` even when zero matching events were found,
  so a healthy idle indexer still shows the cursor climbing every tick.
- On an RPC failure the cursor is deliberately **left untouched** and the same window is
  retried next tick — no events are skipped by a transient outage.
- If every Horizon scan fails, `highestLedger` stays 0, the `main` row is never created,
  and the seed worker therefore re-runs on every restart. Harmless (it upserts), but it
  is why you may see `seed.*` lines on a process that has been running for days.

### Cold start (the ledger window)

With no `attestation` row, the worker asks the RPC for the current ledger and starts at
`latestLedger - INDEXER_EVENT_WINDOW_LEDGERS`, floored at 1. The default is **8000 ledgers**,
roughly **11 hours** at ~5 s/ledger.

That default is a deliberate, empirically-verified margin, not a round guess. Public Soroban
RPC nodes retain only a bounded event history, and testnet's advertised figure (~24h) turns
out to overstate what a single `getEvents` call actually returns: bisecting against
`https://soroban-testnet.stellar.org` found the practical limit is roughly **10,700 ledgers
(~15h)** — past that, `startLedger` still returns a valid `200 OK` with `events: []`, not an
error. **There is nothing to catch.** A window sized to the advertised 24h looks correct and
silently drops everything older than the actual ~15h floor.

For a *resuming* worker this is no longer fatal: when the stored cursor has fallen further
behind the tip than `INDEXER_EVENT_WINDOW_LEDGERS`, the worker does not read events at all —
it **reconciles against contract state** instead (sweeps every handle the database knows
through `resolve`, applying claims, transfers and releases idempotently), cross-checks the
registry's `count()` and logs an error naming the shortfall when bindings exist on-chain
that the database has never seen, then resumes the cursor from the near edge of the
servable window — so the next tick replays the still-readable tail of events
(idempotently) and picks up claims of handles the sweep could not know about. Recovery
needs no manual database edit. What remains unrecoverable from this endpoint is a
never-seen handle claimed in the truly unservable middle of the gap — those take the
archival-RPC backfill below, and the `count()` cross-check tells you whether any exist.

`8000` leaves real margin below that floor. **A first run therefore only sees the last ~11
hours of claims** — bindings older than the window are not reconstructed, and cannot be, from
this endpoint. If you need the complete history, replay it from an archive/full RPC node (set
`INDEXER_RPC_URL`) that actually retains it — raising `INDEXER_EVENT_WINDOW_LEDGERS` against
the *public* endpoint does not help, it just silently truncates further out. Otherwise, accept
the curated seed data as the baseline and let on-chain events accumulate from now on.

Each `getEvents` call takes at most **200 events**. A window with more than 200 events in
it yields the first 200; the cursor then jumps to `latestLedger`, so **the remainder of
that window is skipped**. This only bites on a busy backfill, not in steady state.

### Why the web app cares

The public directory at `/handles` reads the bindings this worker writes whenever the web
app has a `DATABASE_URL`, and falls back to its own cursor-less `getEvents` scan only when
it does not. That fallback carries the same ~11h horizon described above, with none of the
accumulation: it re-derives the whole list on every request, so handles claimed before the
window disappear from the page permanently while the contract's `count()` keeps counting
them. Provisioning this indexer is what makes the directory durable — see
[`apps/web/lib/directory.ts`](../apps/web/lib/directory.ts).

---

## 3. Configuration

Read once at startup in [`src/config.ts`](../apps/indexer/src/config.ts) — every change
requires a restart.

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | — (**required**) | Postgres connection string. Missing → immediate fatal exit. |
| `INDEXER_NETWORK` | `testnet` | Recorded on `Contract.network`. Does **not** change which endpoints are used. |
| `INDEXER_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon endpoint. HTTP (non-TLS) is rejected. |
| `INDEXER_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint for the event stream. |
| `INDEXER_TICK_INTERVAL_MS` | `30000` | Sleep between ticks. |
| `INDEXER_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `INDEXER_REGISTRY_CONTRACT_ID` | falls back to `NEXT_PUBLIC_IDENTITY_REGISTRY_ID`, then `''` | Identity Registry `C…` id. Empty → attestation worker no-ops. |
| `INDEXER_EVENT_WINDOW_LEDGERS` | `8000` | Cold-start lookback, in ledgers. See §Cold start — larger values silently under-scan against the public RPC. |

`--reseed` is a CLI flag, not an env var: `pnpm indexer:seed`.

> The indexer reads `INDEXER_HORIZON_URL` / `INDEXER_RPC_URL`, **not** the
> `STELLAR_HORIZON_URL` / `SOROBAN_RPC_URL` pair used by the web app and the deploy
> script. Setting only the latter leaves the indexer silently pointed at testnet.

---

## 4. Running it

### Locally

```bash
pnpm install
pnpm db:up                                  # Postgres 16 on localhost:5432
pnpm db:migrate                             # apply the Prisma schema
export DATABASE_URL="postgresql://signet:signet@localhost:5432/signet"
pnpm indexer:dev                            # tsx watch — reloads on source changes
```

Useful variants:

```bash
pnpm indexer:seed                                       # re-run the curated seed, then keep ticking
INDEXER_LOG_LEVEL=debug pnpm indexer:dev                # per-record detail
INDEXER_TICK_INTERVAL_MS=5000 pnpm indexer:dev          # tighter loop while debugging
INDEXER_REGISTRY_CONTRACT_ID=C… pnpm indexer:dev        # exercise the attestation worker
pnpm --filter @signet/indexer start                     # no file watching (what prod runs)
```

A healthy first minute looks like this:

```json
{"ts":"…","lvl":"info","msg":"indexer.starting","network":"testnet","horizon":"https://horizon-testnet.stellar.org","rpc":"https://soroban-testnet.stellar.org","registry":"(unset)","interval":30000}
{"ts":"…","lvl":"info","msg":"db.connected"}
{"ts":"…","lvl":"info","msg":"indexer.seeding","reseed":false}
{"ts":"…","lvl":"info","msg":"seed.complete","count":3}
{"ts":"…","lvl":"info","msg":"tick.summary","walletsScanned":3,"eventsDecoded":0,"contractsFound":0,"opsUpserted":0,"snapshotsWritten":0,"durationMs":1841}
```

### In Docker

The image applies migrations on boot (`prisma migrate deploy`, idempotent) and then starts
the worker. **Build from the repo root** — the Dockerfile copies workspace manifests:

```bash
docker build -f apps/indexer/Dockerfile -t signet-indexer .
docker run --rm \
  -e DATABASE_URL="postgresql://signet:signet@host.docker.internal:5432/signet" \
  -e INDEXER_REGISTRY_CONTRACT_ID=C… \
  signet-indexer
```

Point `DATABASE_URL` at a reachable host — `localhost` inside the container is the
container. The process logs to stdout/stderr and expects the platform to restart it; it
does not daemonize or self-heal beyond the per-tick error handling.

---

## 5. Reading the logs

One JSON object per line: `{"ts","lvl","msg",…fields}`. `info`/`debug` go to **stdout**,
`warn`/`error` to **stderr** — a plain `stdout`-only log pipeline will lose every failure.

The heartbeat is one `tick.summary` line per tick:

```json
{"lvl":"info","msg":"tick.summary","walletsScanned":3,"eventsDecoded":0,"contractsFound":0,"opsUpserted":0,"snapshotsWritten":0,"durationMs":1841}
```

No `tick.summary` within ~`INDEXER_TICK_INTERVAL_MS + durationMs` means the process is
wedged or dead. That line is the single best thing to alert on.

| Line | Level | Means | Action |
|------|-------|-------|--------|
| `indexer.starting` | info | Boot. Echoes network, endpoints, registry id (`(unset)` if none), tick interval. | Check the echoed config is what you expect. |
| `db.connected` / `db.disconnected` | info | Prisma connected / clean shutdown. | — |
| `indexer.seeding`, `seed.*` | info | Curated seed ran. | Expected on a fresh DB; see §2 if it repeats every boot. |
| `seed.skippingPlaceholder` | **warn** | Seed data still contains the all-`A` placeholder pubkey. | Replace it in `seed-data.ts`. |
| `tick.summary` | info | Healthy heartbeat. | Alert on absence, not on zeros. |
| `attestation.done` | debug | Event window processed; `throughLedger` is the new cursor. | Confirms the cursor is advancing. |
| `attestation.applied` | debug | One binding applied. | — |
| `attestation.fetchFailed` | **error** | RPC call failed; cursor left in place, window retried next tick. | Isolated → ignore. Repeating → §6. |
| `deployments.txFetchFailed` | **warn** | One transaction couldn't be fetched; that contract is skipped this tick. | Self-heals; a permanent one means the tx is outside Horizon's retention. |
| `deployments.scanFailed` / `operations.scanFailed` | **error** | Horizon scan failed for one wallet. Other wallets still run. | §6 — usually a missing account or a 429. |
| `activity.queryFailed` | **warn** | No transactions readable for a contract; a snapshot with **zero counts is still written**. | Watch for zeroed snapshots on a contract you know is active. |
| `tick.error` | **error** | An exception escaped a worker; this tick is abandoned, the loop continues. | Read the `error` field; persistent → restart. |
| `indexer.shutdown` / `indexer.stopping` | info | Signal received / loop exited. | — |
| `[indexer] fatal: …` | plain stderr | Startup failure. **The process exits 1.** | §6. |

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[indexer] fatal: Error: [indexer] DATABASE_URL is required` | Env var not set. | Export `DATABASE_URL` before starting. |
| `[indexer] fatal: PrismaClientInitializationError: Can't reach database server at …` (`errorCode: 'P1001'`) | Postgres down, wrong host/port, or `localhost` used from inside a container. | `pnpm db:up`; check the host is reachable from where the process runs. **Startup only** — the process exits 1 and must be restarted; a mid-run outage surfaces as `tick.error` instead and self-heals. |
| Table-not-found / column errors from Prisma | Migrations not applied. | `pnpm db:migrate` locally, `pnpm --filter @signet/db run migrate:deploy` in prod (the Docker image does this on boot). |
| `eventsDecoded` always 0, no `attestation.*` lines even at `debug` | No registry id configured — the worker returns immediately. | Set `INDEXER_REGISTRY_CONTRACT_ID` (or `NEXT_PUBLIC_IDENTITY_REGISTRY_ID`) and restart. Confirm via the `registry` field on `indexer.starting`. |
| `attestation.fetchFailed` every tick, `startLedger` far above the network's current ledger | Cursor ahead of the chain — a DB restored from another network, or a testnet reset. Note the `error` field currently renders as `[object Object]` for RPC errors. | Compare with the live ledger, then reset: `DELETE FROM "IndexerCursor" WHERE id = 'attestation';` (cold-starts one window back) or `UPDATE "IndexerCursor" SET "lastLedger" = <n> WHERE id = 'attestation';`. |
| `attestation.fetchFailed` on a `startLedger` older than ~24 h | Public RPC no longer retains that window. | Reset the cursor as above, or point `INDEXER_RPC_URL` at a full-history node. |
| `deployments.scanFailed` / `operations.scanFailed` with `error: "Error: Not Found"` for every wallet | Those accounts don't exist on the configured network — usually curated seed accounts against the wrong network, or unfunded/reset testnet accounts. | Fund the accounts (friendbot on testnet), fix `INDEXER_HORIZON_URL`, or replace the seed wallets. Note this also keeps the `main` cursor from ever being written. |
| `scanFailed` with a 429 / rate-limit error, worsening as wallets are added | Horizon rate-limits the caller IP; the built-in throttle is only 100 ms between calls, and cost grows linearly with tracked wallets and contracts. | Raise `INDEXER_TICK_INTERVAL_MS`, or move to a dedicated/authenticated Horizon instance. Transient — failed wallets are retried next tick. |
| `snapshotsWritten: 0` on every tick | Every contract's snapshot is under 5 minutes old. | Normal. Only investigate if `ContractSnapshot` rows also stop appearing over a longer window. |
| Profile page still shows demo data with the indexer running | The web app falls back to static JSON when the DB has no rows for a handle. | Check the handle exists in `Profile` and that `Operation` rows were written for its wallet. |
| No `tick.summary` for several intervals | Process dead, or a worker is blocked on a hung HTTP call. | Check liveness, then restart — the loop has no per-call timeout. |

---

## 7. Restart, reseed and backfill

**Safe restart.** `SIGTERM`/`SIGINT` are handled: the current tick finishes, the loop
exits within ~250 ms of the sleep chunk, Prisma disconnects, exit code 0. Nothing is
buffered in memory, so a hard kill is also safe — every write is an idempotent upsert and
the worst case is re-reading one event window.

```bash
kill -TERM <pid>            # or docker stop / systemctl restart
```

**Reseed** — re-apply the curated `seed-data.ts` profiles and wallets:

```bash
pnpm indexer:seed           # = pnpm --filter @signet/indexer dev -- --reseed
```

This only upserts profiles and their wallets. It does **not** clear cursors, contracts,
operations or snapshots, and it does not remove profiles deleted from `seed-data.ts`.

**Backfill attestations** — re-read a wider slice of the registry's event stream:

```sql
DELETE FROM "IndexerCursor" WHERE id = 'attestation';
```

then restart with a larger window, e.g. `INDEXER_EVENT_WINDOW_LEDGERS=86400` (~5 days).

**This only works against an archive/full RPC node** (`INDEXER_RPC_URL`) that actually
retains that history. Against the public testnet endpoint it does not degrade gracefully —
`getEvents` returns a normal, error-free `events: []` once `startLedger` is more than
~10,700 ledgers (~15h) behind the tip (see §Cold start), so a large window against the
public RPC looks like it worked and silently skips the backfill entirely, then advances the
cursor past the gap anyway. Point `INDEXER_RPC_URL` at an archival provider before raising
this past the ~8000 default. Re-applying already-seen events is harmless. Remember the
200-events-per-call ceiling too: for a busy backfill, step the cursor forward in chunks
rather than one huge window.

Note that deleting the cursor is only needed to recover handles the database has **never
seen**. For everything else — a worker that was simply down too long — the automatic
reconcile sweep (see §Cold start) already rebuilds the bindings from contract state on the
next tick, and its `count()` cross-check tells you whether an archival backfill is worth
the trouble.

**Full rebuild** (local only):

```bash
docker compose -f infra/docker/docker-compose.yml down -v   # drops the volume
pnpm db:up && pnpm db:migrate
pnpm indexer:dev                                            # seeds, then indexes from scratch
```

**Rotating endpoints or the registry id** requires a restart — config is read once at
startup. Changing `INDEXER_REGISTRY_CONTRACT_ID` to a *different* contract without
resetting the `attestation` cursor will start the new contract's stream at the old
contract's ledger position; reset the cursor at the same time.

---

## 8. Tests

```bash
pnpm --filter @signet/indexer test        # decodeEvent / applyAttestation unit tests
pnpm --filter @signet/indexer typecheck
```

The suite covers event decoding and binding application against an injected store — no
database or network needed.
