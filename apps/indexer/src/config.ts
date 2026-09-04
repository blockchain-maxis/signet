import { assertNetworkUrls } from './network-guard.js';

export interface IndexerConfig {
  databaseUrl: string;
  network: string;
  horizonUrl: string;
  rpcUrl: string;
  tickIntervalMs: number;
  logLevel: string;
  reseed: boolean;
  /** Identity Registry contract id (C…). Empty until the contract is deployed. */
  registryContractId: string;
  /**
   * On first run (no cursor), how many ledgers back to begin reading events.
   * Default is deliberately inside the public RPC's observed practical span
   * for `getEvents` — see apps/web/lib/directory.ts's EVENT_WINDOW_LEDGERS
   * comment for how that boundary was found, and why exceeding it doesn't
   * error, it just silently returns nothing.
   */
  eventWindowLedgers: number;
  /** Operations retention in days (default: 90; 0 to retain indefinitely). */
  operationsRetentionDays: number;
  /** ContractSnapshot retention in days (default: 30; 0 to retain indefinitely). */
  snapshotsRetentionDays: number;
  /** Interval in ms between background pruning passes (default: 3600000 = 1 hour). */
  pruneIntervalMs: number;
}

export function loadConfig(): IndexerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('[indexer] DATABASE_URL is required');

  const network    = process.env.INDEXER_NETWORK     ?? 'testnet';
  const horizonUrl = process.env.INDEXER_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
  const rpcUrl     = process.env.INDEXER_RPC_URL     ?? 'https://soroban-testnet.stellar.org';

  // Fail fast if the network and endpoints disagree (e.g. INDEXER_NETWORK flipped
  // to mainnet but INDEXER_RPC_URL/INDEXER_HORIZON_URL left at their testnet
  // defaults) — otherwise the indexer silently reads the wrong chain.
  assertNetworkUrls(network, [
    { label: 'INDEXER_RPC_URL', url: rpcUrl },
    { label: 'INDEXER_HORIZON_URL', url: horizonUrl },
  ]);

  return {
    databaseUrl,
    network,
    horizonUrl,
    rpcUrl,
    tickIntervalMs:  Number(process.env.INDEXER_TICK_INTERVAL_MS ?? 30_000),
    logLevel:        process.env.INDEXER_LOG_LEVEL        ?? 'info',
    reseed:          process.argv.includes('--reseed'),
    registryContractId:
      process.env.INDEXER_REGISTRY_CONTRACT_ID ??
      process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ??
      '',
    eventWindowLedgers: Number(process.env.INDEXER_EVENT_WINDOW_LEDGERS ?? 8_000),
    operationsRetentionDays: Number(process.env.INDEXER_OPERATIONS_RETENTION_DAYS ?? 90),
    snapshotsRetentionDays: Number(process.env.INDEXER_SNAPSHOTS_RETENTION_DAYS ?? 30),
    pruneIntervalMs: Number(process.env.INDEXER_PRUNE_INTERVAL_MS ?? 3_600_000),
  };
}
