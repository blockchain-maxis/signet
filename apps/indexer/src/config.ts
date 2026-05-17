// Loads indexer configuration from environment variables.
// TODO(signet): validate with zod and fail fast on missing required vars.

export interface IndexerConfig {
  databaseUrl: string | undefined;
  stellarNetwork: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
}

export function loadConfig(): IndexerConfig {
  return {
    databaseUrl: process.env.DATABASE_URL,
    stellarNetwork: process.env.STELLAR_NETWORK ?? 'testnet',
    horizonUrl: process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  };
}
