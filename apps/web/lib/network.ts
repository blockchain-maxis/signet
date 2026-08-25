/**
 * Stellar network resolution for the web app.
 *
 * The live network is configured through `NEXT_PUBLIC_STELLAR_NETWORK` (inlined
 * into both the server and client bundles). Stellar Expert's mainnet path
 * segment is `public`, not `mainnet` — conflating the two silently links to the
 * wrong network's explorer, so the mapping lives in exactly one place here.
 */

export interface ResolvedNetwork {
  /** Normalized network id, e.g. `testnet` / `mainnet` / `public`. */
  network: string;
  /** Stellar Expert path segment: `public` for mainnet, otherwise `testnet`. */
  explorer: 'public' | 'testnet';
  /** Human display label, e.g. `Testnet` / `Mainnet`. */
  name: 'Testnet' | 'Mainnet';
}

/**
 * Pure resolver: maps a raw `NEXT_PUBLIC_STELLAR_NETWORK` value to the network
 * id, its Stellar Expert path segment, and a display label. Defaults to testnet
 * when unset. `public` is accepted as an alias for `mainnet`.
 */
export function resolveNetwork(raw: string | undefined): ResolvedNetwork {
  const network = (raw ?? 'testnet').toLowerCase();
  const isMainnet = network === 'mainnet' || network === 'public';
  return {
    network,
    explorer: isMainnet ? 'public' : 'testnet',
    name: isMainnet ? 'Mainnet' : 'Testnet',
  };
}

const resolved = resolveNetwork(process.env.NEXT_PUBLIC_STELLAR_NETWORK);

/** The configured network id (normalized, lowercased). */
export const STELLAR_NETWORK = resolved.network;
/** Stellar Expert path segment for the configured network (`public`/`testnet`). */
export const STELLAR_EXPLORER = resolved.explorer;
/** Display label for the configured network (`Testnet`/`Mainnet`). */
export const STELLAR_NETWORK_NAME = resolved.name;

/** Stellar Expert account URL for the configured network. */
export function stellarExpertAccountUrl(address: string, explorer: string = STELLAR_EXPLORER): string {
  return `https://stellar.expert/explorer/${explorer}/account/${address}`;
}

/** Stellar Expert transaction URL for the configured network. */
export function stellarExpertTxUrl(hash: string, explorer: string = STELLAR_EXPLORER): string {
  return `https://stellar.expert/explorer/${explorer}/tx/${hash}`;
}
