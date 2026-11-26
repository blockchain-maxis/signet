/**
 * Readiness probing for `GET /api/health`.
 *
 * The probe answers one question for an uptime monitor: is this deployment
 * serving, and if it is degraded, *which* dependency is the reason. Each
 * dependency is therefore a **distinct, independently-reported check** rather
 * than a single boolean — an operator paged at 3am needs to know whether to
 * look at Postgres or at the RPC endpoint.
 *
 * Two rules hold for every check:
 *
 *   • **Unconfigured is not unhealthy.** A dependency the deployment does not
 *     use reports `skipped`, because `/p/*` genuinely serves without Postgres
 *     (from the chain and Horizon) and previews genuinely run without a
 *     registry.
 *   • **Down degrades, it does not fail.** A failed check reports `degraded`
 *     with HTTP 200: the static surfaces still render, and an outage of one
 *     dependency should not make the whole deployment look dead to a load
 *     balancer that would then pull a partially-working instance.
 *
 * Every check is also **time-boxed** ({@link CHECK_TIMEOUT_MS}). A probe that
 * hangs on an unresponsive dependency is worse than one that reports it down:
 * monitors time the request out and report nothing at all about which
 * dependency broke.
 */

import {
  boundCount,
  isRegistryConfigured,
  type RegistryReadOptions,
} from './server/registry-read.ts';
import { getNonceStoreStatus } from './nonce-store.ts';
import { getRateLimitStoreStatus } from './rate-limit.ts';
import { logger } from './logger.ts';

/** Per-dependency verdict. `skipped` means "not configured here", not "healthy". */
export type CheckStatus = 'up' | 'down' | 'skipped';

/**
 * Shared-store verdict. `memory` is the per-instance fallback: not an error,
 * but on a serverless deploy it means replicas do not share a view, so it must
 * be visible rather than reported as `up`.
 */
export type StoreStatus = 'up' | 'down' | 'memory';

/** How long any single dependency gets before it counts as down. */
export const CHECK_TIMEOUT_MS = 2_000;

export interface IndexerReport {
  status: CheckStatus;
  lastTickAt: string | null;
  lagSeconds: number | null;
}

export interface HealthChecks {
  /** Postgres, via a `SELECT 1`. */
  db: CheckStatus;
  /**
   * The on-chain Identity Registry, via the contract's `count` view call —
   * which exercises the whole read path the product depends on: the Soroban
   * RPC endpoint is reachable, and the registry contract answers on it.
   */
  registry: CheckStatus;
  /**
   * The shared store backing single-use sign-in nonces. It fails **closed**
   * (`lib/nonce-store.ts`): when freshness cannot be established the sign-in is
   * refused, so `down` here means authentication is broken right now.
   */
  nonceStore: StoreStatus;
  /**
   * The shared store backing per-ip rate limits. It fails **open**, so `down`
   * is a silent security degradation rather than an outage — reported, but not
   * a reason to call the deployment degraded.
   */
  rateLimitStore: StoreStatus;
  /**
   * Pairing: whether a wallet↔handle binding can be established and read right
   * now. It has no dependency of its own — it is the *composition* of the two
   * that a binding needs, which is why it earns a check rather than being left
   * for an operator to infer from `db` and `registry`:
   *
   *   • the **registry** is where a claim is written and proved, and
   *   • **Postgres** is where the resulting binding is stored and served from,
   *     so a linked wallet stops appearing on the dashboard without it.
   *
   * Either one down means pairing is not operational. `skipped` only when both
   * are skipped: a deployment with neither configured is not doing pairing at
   * all, while a deployment with one of them configured and broken is.
   */
  pairing: CheckStatus;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  ts: string;
  uptimeSeconds: number;
  checks: HealthChecks;
  indexer: IndexerReport;
}

/** Resolve `promise`, or reject once `ms` have passed. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** Postgres reachability. `skipped` when the deployment runs without a database. */
export async function checkDb(): Promise<CheckStatus> {
  if (!process.env.DATABASE_URL) return 'skipped';
  try {
    const { prisma } = await import('@signet/db');
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
    return 'up';
  } catch {
    return 'down';
  }
}

/**
 * Identity Registry readiness.
 *
 * The claim flow, `/handles` and every chain-backed profile resolve against
 * the registry, so an RPC outage takes all of them down — while a probe that
 * only asks Postgres stays green through the whole thing. `count` is the
 * cheapest call that proves the real path works end to end: it is a simulated
 * view call (no signing, no fee, no submission) that still has to reach the
 * RPC endpoint and execute against live ledger state.
 *
 * `boundCount` is documented never to throw — an unreachable endpoint, a
 * contract that isn't deployed and a malformed response all come back as
 * `null` — which is exactly the "could not read the registry" signal this
 * check reports as `down`. The timeout still matters: soft failure says
 * nothing about how long the RPC takes to produce it.
 */
export async function checkRegistry(options: RegistryReadOptions = {}): Promise<CheckStatus> {
  if (!isRegistryConfigured()) return 'skipped';
  try {
    const count = await withTimeout(boundCount(options), CHECK_TIMEOUT_MS);
    return count === null ? 'down' : 'up';
  } catch {
    return 'down';
  }
}

/** Default time after which the indexer is considered stale (10 minutes). */
export const DEFAULT_INDEXER_STALE_AFTER_MS = 10 * 60 * 1000;

export function getIndexerStaleAfterMs(): number {
  const envVal = process.env.INDEXER_STALE_AFTER_MS;
  if (!envVal) return DEFAULT_INDEXER_STALE_AFTER_MS;
  const parsed = parseInt(envVal, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? DEFAULT_INDEXER_STALE_AFTER_MS : parsed;
}

export interface CheckIndexerOptions {
  prisma?: {
    indexerHeartbeat: {
      findUnique?: (args: { where: { worker: string } }) => Promise<{
        worker: string;
        lastSuccessAt: Date | null;
        lastFailureAt: Date | null;
        lastError: string | null;
      } | null>;
      findMany?: () => Promise<Array<{
        worker: string;
        lastSuccessAt: Date | null;
        lastFailureAt: Date | null;
        lastError: string | null;
      }>>;
    };
  };
  now?: () => number;
  staleAfterMs?: number;
}

/**
 * Indexer freshness probe.
 *
 * Checks the `IndexerHeartbeat` table for the `tick` row.
 * Returns `skipped` when running without a database, and `down` when the tick
 * is missing or older than `INDEXER_STALE_AFTER_MS` (default 10 minutes).
 */
export async function checkIndexer(options: CheckIndexerOptions = {}): Promise<IndexerReport> {
  if (!options.prisma && !process.env.DATABASE_URL) {
    return { status: 'skipped', lastTickAt: null, lagSeconds: null };
  }
  try {
    let client = options.prisma;
    if (!client) {
      const { prisma } = await import('@signet/db');
      client = prisma as unknown as CheckIndexerOptions['prisma'];
    }
    if (!client) {
      return { status: 'skipped', lastTickAt: null, lagSeconds: null };
    }

    let tickRow: { worker: string; lastSuccessAt: Date | null; lastFailureAt: Date | null; lastError: string | null } | null = null;
    if (typeof client.indexerHeartbeat.findMany === 'function') {
      const rows = await withTimeout(client.indexerHeartbeat.findMany(), CHECK_TIMEOUT_MS);
      tickRow = rows.find((r) => r.worker === 'tick') ?? null;
      const workerDetails = rows
        .filter((r) => r.worker !== 'tick')
        .map((r) => ({
          worker: r.worker,
          lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
          lastFailureAt: r.lastFailureAt?.toISOString() ?? null,
          lastError: r.lastError,
        }));
      if (workerDetails.length > 0) {
        logger.info({ workers: workerDetails }, 'indexer.workersHeartbeat');
      }
    } else if (typeof client.indexerHeartbeat.findUnique === 'function') {
      tickRow = await withTimeout(
        client.indexerHeartbeat.findUnique({ where: { worker: 'tick' } }),
        CHECK_TIMEOUT_MS,
      );
    }

    if (!tickRow || !tickRow.lastSuccessAt) {
      return { status: 'down', lastTickAt: null, lagSeconds: null };
    }

    const now = options.now ? options.now() : Date.now();
    const lastTickMs = new Date(tickRow.lastSuccessAt).getTime();
    const lagMs = Math.max(0, now - lastTickMs);
    const lagSeconds = Math.floor(lagMs / 1000);
    const staleAfterMs = options.staleAfterMs ?? getIndexerStaleAfterMs();

    const isStale = lagMs > staleAfterMs;
    return {
      status: isStale ? 'down' : 'up',
      lastTickAt: new Date(tickRow.lastSuccessAt).toISOString(),
      lagSeconds,
    };
  } catch {
    return { status: 'down', lastTickAt: null, lagSeconds: null };
  }
}

/**
 * `degraded` when a dependency whose failure users can feel is down.
 *
 * Every check is reported, but they do not all mean the same thing. Postgres,
 * the registry, the nonce store and the indexer each break something a user
 * is doing or rely on fresh state. The rate-limit store failing open leaves
 * the product fully functional and merely unprotected — paging on it would
 * train operators to ignore the probe, so it is surfaced in `checks` and
 * deliberately excluded here.
 */
export function overallStatus(
  checks: HealthChecks,
  indexer?: CheckStatus | IndexerReport,
): 'ok' | 'degraded' {
  const degrading = [checks.db, checks.registry, checks.nonceStore, checks.pairing];
  const indexerStatus = typeof indexer === 'string' ? indexer : indexer?.status;
  if (indexerStatus === 'down') return 'degraded';
  return degrading.includes('down') ? 'degraded' : 'ok';
}

/**
 * Pairing readiness, derived from the checks it is built on rather than probed
 * separately — a second `SELECT 1` and a second `count()` would double the
 * probe's cost to learn nothing new, and could disagree with the checks
 * reported beside it.
 */
export function pairingStatus(db: CheckStatus, registry: CheckStatus): CheckStatus {
  if (db === 'down' || registry === 'down') return 'down';
  if (db === 'skipped' && registry === 'skipped') return 'skipped';
  return 'up';
}

/** Probes to run. Overridable so tests need neither a database nor an RPC. */
export interface HealthProbes {
  db?: () => Promise<CheckStatus>;
  registry?: () => Promise<CheckStatus>;
  nonceStore?: () => Promise<StoreStatus>;
  rateLimitStore?: () => Promise<StoreStatus>;
  indexer?: () => Promise<IndexerReport>;
}

/**
 * Run every check and assemble the report.
 *
 * The checks run concurrently: they are independent, and a serial probe's
 * worst case is the sum of every timeout, which is long enough for a monitor
 * to give up on the request.
 */
export async function collectHealth(probes: HealthProbes = {}): Promise<HealthReport> {
  const [db, registry, nonceStore, rateLimitStore, indexer] = await Promise.all([
    (probes.db ?? checkDb)(),
    (probes.registry ?? checkRegistry)(),
    (probes.nonceStore ?? getNonceStoreStatus)(),
    (probes.rateLimitStore ?? getRateLimitStoreStatus)(),
    (probes.indexer ?? checkIndexer)(),
  ]);

  const checks: HealthChecks = {
    db,
    registry,
    nonceStore,
    rateLimitStore,
    pairing: pairingStatus(db, registry),
  };
  return {
    status: overallStatus(checks, indexer),
    service: 'signet-web',
    ts: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
    indexer,
  };
}
