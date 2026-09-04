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
 *     use reports `skipped`, because the demo `/p/*` surfaces genuinely serve
 *     without Postgres and previews genuinely run without a registry.
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

/**
 * `degraded` when a dependency whose failure users can feel is down.
 *
 * Every check is reported, but they do not all mean the same thing. Postgres,
 * the registry and the nonce store each break something a user is doing right
 * now. The rate-limit store failing open leaves the product fully functional
 * and merely unprotected — paging on it would train operators to ignore the
 * probe, so it is surfaced in `checks` and deliberately excluded here.
 */
export function overallStatus(checks: HealthChecks): 'ok' | 'degraded' {
  const degrading = [checks.db, checks.registry, checks.nonceStore, checks.pairing];
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
}

/**
 * Run every check and assemble the report.
 *
 * The checks run concurrently: they are independent, and a serial probe's
 * worst case is the sum of every timeout, which is long enough for a monitor
 * to give up on the request.
 */
export async function collectHealth(probes: HealthProbes = {}): Promise<HealthReport> {
  const [db, registry, nonceStore, rateLimitStore] = await Promise.all([
    (probes.db ?? checkDb)(),
    (probes.registry ?? checkRegistry)(),
    (probes.nonceStore ?? getNonceStoreStatus)(),
    (probes.rateLimitStore ?? getRateLimitStoreStatus)(),
  ]);

  const checks: HealthChecks = {
    db,
    registry,
    nonceStore,
    rateLimitStore,
    pairing: pairingStatus(db, registry),
  };
  return {
    status: overallStatus(checks),
    service: 'signet-web',
    ts: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  };
}
