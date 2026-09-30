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

| Table                | Default Retention        | Config Variable                        | Pruning Cadence | Description                                                           |
| -------------------- | ------------------------ | -------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `Operation`          | **90 days**              | `INDEXER_OPERATIONS_RETENTION_DAYS`    | Every 1 hour    | Invocations older than 90 days are deleted.                           |
| `ContractSnapshot`   | **30 days**              | `INDEXER_SNAPSHOTS_RETENTION_DAYS`     | Every 1 hour    | Periodic contract activity snapshots older than 30 days are pruned.   |
| `ContractInvocation` | **1000 rows / contract** | `INDEXER_INVOCATIONS_MAX_PER_CONTRACT` | Every 1 hour    | Caps invocation index rows per contract to the most recent N records. |
| `PairingState`       | **24 hours**             | _(Fixed, not configurable)_            | Every 1 hour    | Ephemeral CLI pairing state rows older than 24 hours are pruned.      |

> **Indefinite Retention Option:** Setting `INDEXER_OPERATIONS_RETENTION_DAYS=0`, `INDEXER_SNAPSHOTS_RETENTION_DAYS=0`, or `INDEXER_INVOCATIONS_MAX_PER_CONTRACT=0` disables pruning and retains records indefinitely. Operators choosing indefinite retention should allocate Postgres storage to accommodate unbounded linear growth.

### Profile statistics and retention

Profile invocation counts, function diversity, and the reputation heuristic are computed from the `Operation` rows that are still present in Postgres. They are therefore **retention-window statistics**, not lifetime statistics, whenever operation pruning is enabled.

With the default configuration, profile statistics represent the **last 90 days** of indexed operations. As operations age out of the retention window, those values can decrease; that is expected behavior for a rolling window and is surfaced explicitly in the profile UI and API metadata.

The web app reads `INDEXER_OPERATIONS_RETENTION_DAYS` only to label this scope. Deployments that override the indexer's default must expose the same value to the web process so the displayed window matches the pruning policy. When the value is `0`, operation pruning is disabled and database-backed statistics cover the full indexed history.

---

## 3. Pruning Architecture

The pruning worker ([`apps/indexer/src/workers/prune.ts`](../apps/indexer/src/workers/prune.ts)) executes periodically inside the indexer main loop:

1. **Interval Execution:** Evaluates whether `INDEXER_PRUNE_INTERVAL_MS` (default `3,600,000` ms = 1 hour) has elapsed since the last pass.
2. **Operations Ingestion and Pruning:** The operations worker stops paging at `createdAt < now - retentionDays` and does not store older invocations; the pruning worker deletes existing `Operation` rows older than that same cutoff.
3. **Snapshots Pruning:** Deletes `ContractSnapshot` rows where `capturedAt < now - retentionDays`.
4. **Contract Invocations Pruning:** Keeps at most `INDEXER_INVOCATIONS_MAX_PER_CONTRACT` newest rows per contract, deleting older excess rows.
5. **Pairing State Pruning:** Deletes ephemeral `PairingState` rows where `expiresAt` is more than 24 hours in the past.
6. **Structured Metrics:** Logs `opsPruned`, `snapshotsPruned`, `invocationsPruned`, and `pairingsPruned` in indexer tick metrics.

---

## 4. Configuration Reference

| Environment Variable                   | Default   | Description                                                                |
| -------------------------------------- | --------- | -------------------------------------------------------------------------- |
| `INDEXER_OPERATIONS_RETENTION_DAYS`    | `90`      | Maximum age in days for indexed `Operation` rows. `0` disables pruning.    |
| `INDEXER_SNAPSHOTS_RETENTION_DAYS`     | `30`      | Maximum age in days for `ContractSnapshot` rows. `0` disables pruning.     |
| `INDEXER_INVOCATIONS_MAX_PER_CONTRACT` | `1000`    | Maximum number of invocations retained per contract. `0` disables pruning. |
| `INDEXER_PRUNE_INTERVAL_MS`            | `3600000` | Pruning check interval in milliseconds (default: 1 hour).                  |

---

## 5. Cost & Storage Implications

- **With Default Retention (90d / 30d):** Table sizes remain steady and bounded proportional to current active developers rather than total historical activity.
- **With Indefinite Retention (`=0`):** Requires scaling Postgres disk storage proportionally to total on-chain transaction volume across all tracked wallets over the lifetime of the deployment.
