import { logger } from './logger.js';
import type { DeploymentResult } from './workers/deployment.js';
import type { ExecutableRefreshResult } from './workers/executable-refresh.js';
import type { InvocationsResult } from './workers/invocations.js';
import type { OperationsResult } from './workers/operations.js';
import type { PruningResult } from './workers/prune.js';

/**
 * One tick of the indexer, and the sleep between two ticks.
 *
 * Both live here rather than in `index.ts` so that they can be tested:
 * `index.ts` starts the indexer as soon as it is imported. Everything that
 * touches the database or the network is passed in.
 */

/** The workers of one tick, each already bound to its clients, store and config. */
export interface TickWorkers {
  attestation: () => Promise<{ eventsDecoded: number }>;
  deployment: () => Promise<DeploymentResult>;
  activity: () => Promise<{ snapshotsWritten: number }>;
  operations: () => Promise<Pick<OperationsResult, 'opsUpserted'>>;
  /** Left out when invocation capture is switched off. */
  invocations?: () => Promise<Pick<InvocationsResult, 'invocationsUpserted'>>;
  executableRefresh: () => Promise<Pick<ExecutableRefreshResult, 'wasmChanged'>>;
  /** Left out on a tick where pruning is not due. */
  prune?: () => Promise<
    Pick<PruningResult, 'opsPruned' | 'snapshotsPruned' | 'invocationsPruned' | 'pairingsPruned'>
  >;
  /** Saves the `main` cursor. Called only when the deployment worker saw a ledger. */
  saveCursor: (highestLedger: number) => Promise<void>;
}

/** The fields of the `tick.summary` log line. */
export interface TickSummary {
  walletsScanned: number;
  eventsDecoded: number;
  contractsFound: number;
  opsUpserted: number;
  invocationsUpserted: number;
  snapshotsWritten: number;
  wasmChanged: number;
  opsPruned: number;
  snapshotsPruned: number;
  invocationsPruned: number;
  pairingsPruned: number;
  /**
   * The workers that threw this tick, in the order they ran; empty when none
   * did. `cursor` is the save of the `main` cursor at the end of the tick.
   */
  failedWorkers: string[];
  durationMs: number;
}

/**
 * Runs one worker and keeps a failure inside it. A worker that throws is
 * logged as `worker.failed` and counts as `zero` in the tick's totals, so the
 * workers after it still run.
 */
export async function runWorker<T>(
  name: string,
  fn: () => Promise<T>,
  zero: T,
): Promise<{ result: T; failed: boolean }> {
  try {
    return { result: await fn(), failed: false };
  } catch (err) {
    logger.error({ worker: name, error: String(err) }, 'worker.failed');
    return { result: zero, failed: true };
  }
}

/**
 * Runs the workers of one tick, one after another, and logs `tick.summary`.
 *
 * Each worker is isolated from the others by {@link runWorker}: the Horizon
 * workers keep running through a Soroban RPC outage, and the other way round.
 * This never rejects because a worker failed. The summary's `failedWorkers`
 * names the ones that did.
 */
export async function runTick(workers: TickWorkers): Promise<TickSummary> {
  const start = Date.now();
  logger.debug({}, 'tick.start');

  const failedWorkers: string[] = [];
  const run = async <T>(name: string, fn: () => Promise<T>, zero: T): Promise<T> => {
    const { result, failed } = await runWorker(name, fn, zero);
    if (failed) failedWorkers.push(name);
    return result;
  };

  // Attestations: ingest on-chain claim/release events into the DB
  const { eventsDecoded } = await run('attestation', workers.attestation, { eventsDecoded: 0 });

  // Deployments: find new contract creations for all tracked wallets. Wallets
  // are (re-)read fresh from the store on every call, so one linked mid-life
  // — after the indexer started — is scanned starting the very next tick.
  const { highestLedger, walletsScanned, contractsFound } = await run(
    'deployment',
    workers.deployment,
    { highestLedger: 0, walletsScanned: 0, contractsFound: 0 },
  );

  // Activity: refresh snapshots for tracked contracts. Same freshness
  // guarantee as deployments — a contract the deployment worker just found
  // this tick already shows up in this call's `contract.findMany()`.
  const { snapshotsWritten } = await run('activity', workers.activity, { snapshotsWritten: 0 });

  // Operations: pull recent Soroban invocations for tracked wallets
  const { opsUpserted } = await run('operations', workers.operations, { opsUpserted: 0 });

  // Invocations: capture per-contract invocations, footprints, and state mutations
  const { invocationsUpserted } = workers.invocations
    ? await run('invocations', workers.invocations, { invocationsUpserted: 0 })
    : { invocationsUpserted: 0 };

  // Executable refresh: backfill missing WASM hashes and detect on-chain contract upgrades
  const { wasmChanged } = await run('executable-refresh', workers.executableRefresh, {
    wasmChanged: 0,
  });

  // Pruning: periodically prune historical operations, snapshots, and invocations beyond retention windows
  const notPruned = { opsPruned: 0, snapshotsPruned: 0, invocationsPruned: 0, pairingsPruned: 0 };
  const { opsPruned, snapshotsPruned, invocationsPruned, pairingsPruned } = workers.prune
    ? await run('prune', workers.prune, notPruned)
    : notPruned;

  // Persist cursor
  if (highestLedger > 0) {
    await run('cursor', () => workers.saveCursor(highestLedger), undefined);
  }

  // One structured metrics line per tick. Per-record detail is logged at debug
  // level inside each worker, so the default (info) output stays one line/tick.
  const summary: TickSummary = {
    walletsScanned,
    eventsDecoded,
    contractsFound,
    opsUpserted,
    invocationsUpserted,
    snapshotsWritten,
    wasmChanged,
    opsPruned,
    snapshotsPruned,
    invocationsPruned,
    pairingsPruned,
    failedWorkers,
    durationMs: Date.now() - start,
  };
  logger.info({ ...summary }, 'tick.summary');
  return summary;
}

/** How long the idle loop sleeps between two looks at whether it should stop. */
const IDLE_POLL_MS = 250;

// How often the idle-sleep loop checks for a pending index request — the
// worst-case delay before a just-linked wallet gets scanned, once the current
// tick has already finished. Deliberately much shorter than the tick interval
// itself (default 30s) and cheap: one indexed lookup, not a full tick.
export const PENDING_CHECK_INTERVAL_MS = 2_000;

export interface IdleOptions {
  /** The longest the sleep lasts: the configured tick interval. */
  intervalMs: number;
  isShuttingDown: () => boolean;
  /** True when a wallet is waiting to be indexed, which ends the sleep early. */
  hasPendingIndexRequest: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** The clock. Tests pass their own. */
  now?: () => number;
}

/**
 * Sleeps until the next tick is due.
 *
 * Sleeps in small chunks so we can react to shutdown quickly, and — on a
 * slower cadence than the shutdown check, since it costs a query — to a
 * just-linked wallet's indexRequestedAt: start the next tick early rather
 * than making it wait out the rest of this interval.
 */
export async function idleUntilNextTick(options: IdleOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const end = now() + options.intervalMs;
  let lastPendingCheck = 0;
  while (!options.isShuttingDown() && now() < end) {
    await options.sleep(IDLE_POLL_MS);
    if (now() - lastPendingCheck >= PENDING_CHECK_INTERVAL_MS) {
      lastPendingCheck = now();
      let pending = false;
      try {
        pending = await options.hasPendingIndexRequest();
      } catch (err) {
        // The check is a database query, and the indexer is idle for most of
        // every interval, so this is where a database outage usually lands. It
        // must not escape: in `index.ts` an error that leaves the main loop
        // ends in a shutdown with exit code 0. Treat it as "nothing pending"
        // and keep sleeping. The next tick reports the outage worker by worker.
        logger.warn({ error: String(err) }, 'tick.pendingCheckFailed');
      }
      if (pending) {
        logger.debug({}, 'tick.pendingIndexRequest');
        break;
      }
    }
  }
}
