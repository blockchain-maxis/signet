import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { connectDb, disconnectDb, prisma } from './db.js';
import { createHorizonServer, sleep } from './stellar.js';
import { createSorobanRpcServer } from './soroban-rpc.js';
import { runSeedWorker } from './workers/seed.js';
import { runDeploymentWorker, type DeploymentStore } from './workers/deployment.js';
import { runActivityWorker, type ActivityStore } from './workers/activity.js';
import { runAttestationWorker } from './workers/attestation.js';
import { runOperationsWorker, type OperationsStore } from './workers/operations.js';

let shuttingDown = false;
let shuttingDownPrisma = false;

/** Max time (ms) to wait for a graceful shutdown before force-exiting. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

// Liveness marker, refreshed after every successful tick. The Docker
// HEALTHCHECK reads its mtime and reports the worker unhealthy once it goes
// stale, so a wedged loop (which never completes a tick) can't look healthy.
const LIVENESS_FILE = process.env.INDEXER_LIVENESS_FILE ?? '/tmp/indexer-alive';

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
  const start = Date.now();
  logger.debug({}, 'tick.start');

  // Attestations: ingest on-chain claim/release events into the DB
  const { eventsDecoded } = await runAttestationWorker(soroban, config);

  // Deployments: find new contract creations for all tracked wallets. Wallets
  // are (re-)read fresh from the store on every call, so one linked mid-life
  // — after the indexer started — is scanned starting the very next tick.
  const { highestLedger, walletsScanned, contractsFound } = await runDeploymentWorker(
    horizon,
    config,
    prisma as unknown as DeploymentStore,
  );

  // Activity: refresh snapshots for tracked contracts. Same freshness
  // guarantee as deployments — a contract the deployment worker just found
  // this tick already shows up in this call's `contract.findMany()`.
  const { snapshotsWritten } = await runActivityWorker(horizon, prisma as unknown as ActivityStore);

  // Operations: pull recent Soroban invocations for tracked wallets
  const { opsUpserted } = await runOperationsWorker(horizon, prisma as unknown as OperationsStore);

  // Persist cursor
  if (highestLedger > 0) {
    await prisma.indexerCursor.upsert({
      where:  { id: 'main' },
      update: { lastLedger: highestLedger },
      create: { id: 'main', lastLedger: highestLedger },
    });
  }

  // One structured metrics line per tick. Per-record detail is logged at debug
  // level inside each worker, so the default (info) output stays one line/tick.
  logger.info(
    {
      walletsScanned,
      eventsDecoded,
      contractsFound,
      opsUpserted,
      snapshotsWritten,
      durationMs: Date.now() - start,
    },
    'tick.summary',
  );
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

  // Check if we need to seed
  const cursor = await prisma.indexerCursor.findUnique({ where: { id: 'main' } });
  if (!cursor || config.reseed) {
    logger.info({ reseed: config.reseed }, 'indexer.seeding');
    await runSeedWorker();
  }

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
        await markAlive();
      } catch (err) {
        logger.error({ error: String(err) }, 'tick.error');
      }

      if (shuttingDown) break;

      // Sleep in small chunks so we can react to shutdown quickly
      const end = Date.now() + config.tickIntervalMs;
      while (!shuttingDown && Date.now() < end) {
        await sleep(250);
      }
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
