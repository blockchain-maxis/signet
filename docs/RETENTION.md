# Retention & Pruning Policy

Signet indexes on-chain operations (`Operation`) and periodically captures contract activity statistics (`ContractSnapshot`) for all tracked wallets. This document outlines the retention policy, storage bounds, rationale, and operational controls for managing historical data.

---

## 1. Context & Motivation

As tracked wallets increase and developer activity grows, unconstrained accumulation of historical operations and snapshots presents challenges:
- **Storage Growth:** Active developers execute thousands of `invoke_host_function` operations. Retaining millions of older invocations indefinitely increases Postgres disk footprint and backup sizes without serving active product features.
- **Query Performance:** Profile views query recent activity (the newest 25–100 operations on `/p/{handle}`). Querying and scanning large unpartitioned tables adds latency over time.
- **Cost Bounds:** Free-tier and managed databases (e.g. Neon, Supabase, AWS RDS) impose storage thresholds. Pruning older data preserves predictable operating costs.

---

## 2. Retention Decision

Signet adopts an **active window retention policy** with configurable thresholds:

| Table | Default Retention | Config Variable | Pruning Cadence | Description |
|---|---|---|---|---|
| `Operation` | **90 days** | `INDEXER_OPERATIONS_RETENTION_DAYS` | Every 1 hour | Invocations older than 90 days are deleted. |
| `ContractSnapshot` | **30 days** | `INDEXER_SNAPSHOTS_RETENTION_DAYS` | Every 1 hour | Periodic contract activity snapshots older than 30 days are pruned. |

> **Indefinite Retention Option:** Setting `INDEXER_OPERATIONS_RETENTION_DAYS=0` or `INDEXER_SNAPSHOTS_RETENTION_DAYS=0` disables pruning and retains records indefinitely. Operators choosing indefinite retention should allocate Postgres storage to accommodate unbounded linear growth.

---

## 3. Pruning Architecture

The pruning worker ([`apps/indexer/src/workers/prune.ts`](../apps/indexer/src/workers/prune.ts)) executes periodically inside the indexer main loop:

1. **Interval Execution:** Evaluates whether `INDEXER_PRUNE_INTERVAL_MS` (default `3,600,000` ms = 1 hour) has elapsed since the last pass.
2. **Operations Pruning:** Deletes `Operation` rows where `createdAt < now - retentionDays`.
3. **Snapshots Pruning:** Deletes `ContractSnapshot` rows where `capturedAt < now - retentionDays`.
4. **Structured Metrics:** Logs `opsPruned` and `snapshotsPruned` in indexer tick metrics.

---

## 4. Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `INDEXER_OPERATIONS_RETENTION_DAYS` | `90` | Maximum age in days for indexed `Operation` rows. `0` disables pruning. |
| `INDEXER_SNAPSHOTS_RETENTION_DAYS` | `30` | Maximum age in days for `ContractSnapshot` rows. `0` disables pruning. |
| `INDEXER_PRUNE_INTERVAL_MS` | `3600000` | Pruning check interval in milliseconds (default: 1 hour). |

---

## 5. Cost & Storage Implications

- **With Default Retention (90d / 30d):** Table sizes remain steady and bounded proportional to current active developers rather than total historical activity.
- **With Indefinite Retention (`=0`):** Requires scaling Postgres disk storage proportionally to total on-chain transaction volume across all tracked wallets over the lifetime of the deployment.
