import { boundCount, type RegistryReadOptions } from './server/registry-read.ts';
import { getConfiguredNetwork } from './cli-link.ts';
import { REGISTRY_CONTRACT_ID } from './chain.ts';

export interface RegistryStatsDbStore {
  wallet?: {
    count(): Promise<number>;
  };
  contract?: {
    count(): Promise<number>;
  };
}

export interface RegistryStatsOptions {
  registry?: RegistryReadOptions;
  db?: RegistryStatsDbStore | null;
  network?: string;
  registryContract?: string;
}

export interface RegistryStatsData {
  network: string;
  registryContract: string;
  boundHandles: number | null;
  indexedWallets: number | null;
  indexedContracts: number | null;
}

/**
 * Fetch counts for indexed wallets and contracts from the database.
 * Returns null for both if DATABASE_URL is not set or if DB read fails.
 */
async function fetchIndexedCounts(
  store?: RegistryStatsDbStore | null,
): Promise<{ indexedWallets: number | null; indexedContracts: number | null }> {
  try {
    let db = store;
    if (db === undefined) {
      if (!process.env.DATABASE_URL) {
        return { indexedWallets: null, indexedContracts: null };
      }
      const { prisma } = await import('@signet/db');
      db = prisma as unknown as RegistryStatsDbStore;
    }

    if (!db || !db.wallet?.count || !db.contract?.count) {
      return { indexedWallets: null, indexedContracts: null };
    }

    const [indexedWallets, indexedContracts] = await Promise.all([
      db.wallet.count(),
      db.contract.count(),
    ]);

    return {
      indexedWallets: typeof indexedWallets === 'number' && Number.isFinite(indexedWallets) && indexedWallets >= 0
        ? Math.trunc(indexedWallets)
        : null,
      indexedContracts: typeof indexedContracts === 'number' && Number.isFinite(indexedContracts) && indexedContracts >= 0
        ? Math.trunc(indexedContracts)
        : null,
    };
  } catch {
    return { indexedWallets: null, indexedContracts: null };
  }
}

/**
 * Collect public registry statistics for dashboards and ecosystem reports.
 * Any count that cannot be read/computed is returned as null, never 0.
 */
export async function getRegistryStats(
  options: RegistryStatsOptions = {},
): Promise<RegistryStatsData> {
  const network = options.network ?? getConfiguredNetwork();
  const registryContract = options.registryContract ?? (process.env.REGISTRY_CONTRACT_ID ?? process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ?? REGISTRY_CONTRACT_ID);

  const [boundHandles, indexedCounts] = await Promise.all([
    boundCount(options.registry),
    fetchIndexedCounts(options.db),
  ]);

  return {
    network,
    registryContract,
    boundHandles,
    indexedWallets: indexedCounts.indexedWallets,
    indexedContracts: indexedCounts.indexedContracts,
  };
}
