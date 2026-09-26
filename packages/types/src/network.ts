/**
 * @file @signet/types
 *
 * Canonical Network type, aliases, and passphrase mappings.
 */

/**
 * Supported Stellar networks across Signet services.
 */
export const NETWORKS = ['testnet', 'mainnet', 'futurenet', 'local'] as const;

export type Network = (typeof NETWORKS)[number];

const PASSPHRASES: Record<Network, string> = {
  testnet: 'Test SDF Network ; September 2015',
  mainnet: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
  local: 'Standalone Network ; February 2017',
};

/**
 * Type guard for canonical Network strings.
 */
export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);
}

/**
 * Normalizes an arbitrary network string or alias to a canonical Network.
 * Accepts "public" and "pubnet" (case-insensitive, whitespace-trimmed) as aliases for "mainnet".
 * Throws an Error if the network is unrecognized.
 */
export function normalizeNetwork(raw: string): Network {
  if (typeof raw !== 'string') {
    throw new Error(`Invalid network: expected string, got ${typeof raw}`);
  }

  const trimmed = raw.trim().toLowerCase();

  if (trimmed === 'public' || trimmed === 'pubnet') {
    return 'mainnet';
  }

  if (isNetwork(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Unknown Stellar network: "${raw}". Expected one of: ${NETWORKS.join(', ')} (or aliases: public, pubnet)`,
  );
}

/**
 * Returns the standard Stellar network passphrase for a canonical network.
 */
export function networkPassphrase(network: Network): string {
  const passphrase = PASSPHRASES[network];
  if (!passphrase) {
    throw new Error(`No network passphrase configured for network: ${network}`);
  }
  return passphrase;
}
