import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { connectDb, disconnectDb, prisma } from './db.js';
import { createHorizonServer, sleep } from './stellar.js';
import { createSorobanRpcServer } from './soroban-rpc.js';
import { createContractExecutableReader } from './contract-executable.js';
import { runDeploymentWorker, type DeploymentStore } from './workers/deployment.js';
import { runActivityWorker, type ActivityStore } from './workers/activity.js';
import { runAttestationWorker } from './workers/attestation.js';
import { runOperationsWorker, type OperationsStore } from './workers/operations.js';
import { runInvocationsWorker, type InvocationsStore } from './workers/invocations.js';
import { runPruningWorker, type PruningStore } from './workers/prune.js';
import {
  runExecutableRefreshWorker,
  type ExecutableRefreshStore,
} from './workers/executable-refresh.js';
import { idleUntilNextTick, runTick } from './tick.js';

let shuttingDown = false;
let shuttingDownPrisma = false;
let lastPrunedAt = 0;

/** Max time (ms) to wait for a graceful shutdown before force-exiting. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

// Liveness marker, refreshed at the end of every tick. The Docker HEALTHCHECK
// reads its mtime and reports the worker unhealthy once it goes stale, so a
// wedged loop (which never completes a tick) can't look healthy.
//
// Liveness means the loop is turning, and nothing more. A tick completes
// whether or not its workers succeeded (see `runTick`), so a tick in which
// every worker failed still refreshes the marker: a restart, which is what an
// unhealthy container asks for, would not bring a database or an RPC endpoint
// back. What failed is in `failedWorkers` on the `tick.summary` line.
const LIVENESS_FILE = process.env.INDEXER_LIVENESS_FILE ?? '/tmp/indexer-alive';

/**
 * True when any wallet has a pending index request — apps/web/lib/server/
 * account.ts's linkDeployWallet sets Wallet.indexRequestedAt on every
 * (re-)link. Lets the idle-sleep loop start the next tick early instead of
 * waiting out the rest of the configured interval, without any new IPC: the
 * database the indexer already polls is the signal channel.
 */
async function hasPendingIndexRequest(): Promise<boolean> {
  const pending = await prisma.wallet.findFirst({
    where: { indexRequestedAt: { not: null } },
    select: { id: true },
  });
  return pending !== null;
}

async function markAlive(): Promise<void> {
  try {
    await writeFile(LIVENESS_FILE, `${Date.now()}\n`);
  } catch (err) {
    logger.warn({ error: String(err), file: LIVENESS_FILE }, 'liveness.writeFailed');
  }
}

async function tick(
  horizon: ReturnType<typeof createHorizonServer>,
  soroban: ReturnType<typeof createSorobanRpcServer>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  // The order the workers run in, what each is for, and the isolation between
  // them are in `runTick`. This only binds each one to its clients and store.
  await runTick({
    attestation: () => runAttestationWorker(soroban, config),
    deployment: () =>
      runDeploymentWorker(
        horizon,
        config,
        prisma,
        createContractExecutableReader(soroban),
      ),
    activity: () => runActivityWorker(prisma, config),
    operations: () => runOperationsWorker(horizon, prisma, config),
    invocations: config.captureInvocations
      ? () => runInvocationsWorker(soroban, config, prisma)
      : undefined,
    executableRefresh: () =>
      runExecutableRefreshWorker(soroban, config, prisma),
    prune:
      Date.now() - lastPrunedAt >= config.pruneIntervalMs
        ? async () => {
            const res = await runPruningWorker(prisma, config);
            lastPrunedAt = Date.now();
            return res;
          }
        : undefined,
    saveCursor: async (highestLedger) => {
      await prisma.indexerCursor.upsert({
        where:  { id: 'main' },
        update: { lastLedger: highestLedger },
        create: { id: 'main', lastLedger: highestLedger },
      });
    },
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info(
    {
      network:  config.network,
      horizon:  config.horizonUrl,
      rpc:      config.rpcUrl,
      registry: config.registryContractId || '(unset)',
      interval: config.tickIntervalMs,
    },
    'indexer.starting',
  );

  await connectDb();

  const horizon = createHorizonServer(config.horizonUrl);
  const soroban = createSorobanRpcServer(config.rpcUrl);

  // Graceful shutdown
  function onSignal(signal: string) {
    if (shuttingDown) {
      // Second signal: force exit immediately
      logger.warn({ signal }, 'indexer.force_shutdown');
      process.exit(1);
    }
    logger.info({ signal }, 'indexer.shutdown');
    shuttingDown = true;
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT',  () => onSignal('SIGINT'));

  try {
    // Main loop
    while (!shuttingDown) {
      try {
        await tick(horizon, soroban, config);
        // Only a completed tick refreshes liveness; a throw leaves it to go stale.
        // A worker that fails no longer throws out of the tick, so this is every
        // tick unless something outside the workers breaks.
        await markAlive();
      } catch (err) {
        logger.error({ error: String(err) }, 'tick.error');
      }

      if (shuttingDown) break;

      await idleUntilNextTick({
        intervalMs: config.tickIntervalMs,
        isShuttingDown: () => shuttingDown,
        hasPendingIndexRequest,
        sleep,
      });
    }
  } finally {
    await gracefulShutdown();
  }
}

async function gracefulShutdown(): Promise<void> {
  // Prevent concurrent shutdown attempts
  if (shuttingDownPrisma) return;
  shuttingDownPrisma = true;

  logger.info({}, 'indexer.stopping');

  // Force exit if graceful shutdown takes too long
  const forceExit = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'indexer.force_exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await disconnectDb();
    process.exitCode = 0;
  } catch (err) {
    logger.error({ error: String(err) }, 'indexer.disconnect_error');
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExit);
  }

  // Ensure the process exits. After Prisma disconnect there may still be
  // lingering handles that prevent the event loop from draining.
  process.exit(process.exitCode);
}

main().catch((err: unknown) => {
  console.error('[indexer] fatal:', err);
  process.exit(1);
});
