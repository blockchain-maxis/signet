import { loadConfig } from './config.js';
import { logger, setLogLevel } from './logger.js';
import { connectDb, disconnectDb, prisma } from './db.js';
import { createHorizonServer, sleep } from './stellar.js';
import { runSeedWorker } from './workers/seed.js';
import { runDeploymentWorker } from './workers/deployment.js';
import { runActivityWorker } from './workers/activity.js';

let shuttingDown = false;

async function tick(
  horizon: ReturnType<typeof createHorizonServer>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const start = Date.now();
  logger.info({}, 'tick.start');

  // Deployments: find new contract creations for all tracked wallets
  const highestLedger = await runDeploymentWorker(horizon, config);

  // Activity: refresh snapshots for tracked contracts
  await runActivityWorker(horizon);

  // Persist cursor
  if (highestLedger > 0) {
    await prisma.indexerCursor.upsert({
      where:  { id: 'main' },
      update: { lastLedger: highestLedger },
      create: { id: 'main', lastLedger: highestLedger },
    });
  }

  logger.info({ durationMs: Date.now() - start }, 'tick.end');
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  logger.info(
    {
      network:  config.network,
      horizon:  config.horizonUrl,
      interval: config.tickIntervalMs,
    },
    'indexer.starting',
  );

  await connectDb();

  const horizon = createHorizonServer(config.horizonUrl);

  // Check if we need to seed
  const cursor = await prisma.indexerCursor.findUnique({ where: { id: 'main' } });
  if (!cursor || config.reseed) {
    logger.info({ reseed: config.reseed }, 'indexer.seeding');
    await runSeedWorker();
  }

  // Graceful shutdown
  function onSignal(signal: string) {
    logger.info({ signal }, 'indexer.shutdown');
    shuttingDown = true;
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT',  () => onSignal('SIGINT'));

  // Main loop
  while (!shuttingDown) {
    try {
      await tick(horizon, config);
    } catch (err) {
      logger.error({ error: String(err) }, 'tick.error');
    }

    // Sleep in small chunks so we can react to shutdown quickly
    const end = Date.now() + config.tickIntervalMs;
    while (!shuttingDown && Date.now() < end) {
      await sleep(250);
    }
  }

  logger.info({}, 'indexer.stopping');
  await disconnectDb();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('[indexer] fatal:', err);
  process.exit(1);
});
