export interface IndexerConfig {
  databaseUrl: string;
  network: string;
  horizonUrl: string;
  rpcUrl: string;
  tickIntervalMs: number;
  logLevel: string;
  reseed: boolean;
}

export function loadConfig(): IndexerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('[indexer] DATABASE_URL is required');

  return {
    databaseUrl,
    network:         process.env.INDEXER_NETWORK          ?? 'mainnet',
    horizonUrl:      process.env.INDEXER_HORIZON_URL      ?? 'https://horizon.stellar.org',
    rpcUrl:          process.env.INDEXER_RPC_URL          ?? 'https://soroban-rpc.stellar.org',
    tickIntervalMs:  Number(process.env.INDEXER_TICK_INTERVAL_MS ?? 30_000),
    logLevel:        process.env.INDEXER_LOG_LEVEL        ?? 'info',
    reseed:          process.argv.includes('--reseed'),
  };
}
