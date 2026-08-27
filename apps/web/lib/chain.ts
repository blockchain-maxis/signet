/**
 * Shared read-only chain configuration for the server side of the web app.
 *
 * Every server-rendered surface that reads the Identity Registry — the public
 * handle directory (`lib/directory.ts`) and profile resolution
 * (`lib/profiles.ts`) — resolves against the same contract, the same RPC
 * endpoint and the same network, so they can never disagree about which
 * registry is authoritative.
 *
 * Both the server-only (`REGISTRY_CONTRACT_ID`, `SOROBAN_RPC_URL`) and the
 * public (`NEXT_PUBLIC_*`) forms are accepted, so a single deployment
 * environment works whether or not the value is also exposed to the client.
 *
 * This module deliberately has no `@stellar/stellar-sdk` import: it is plain
 * configuration, so modules that only need the sdk on one code path can keep
 * importing it lazily.
 */

import { assertNetworkUrls } from './network-guard.ts';

export const REGISTRY_CONTRACT_ID =
  process.env.REGISTRY_CONTRACT_ID ?? process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID ?? '';

export const SOROBAN_RPC_URL =
  process.env.SOROBAN_RPC_URL ??
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  'https://soroban-testnet.stellar.org';

export const STELLAR_NETWORK = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet').toLowerCase();

export const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === 'mainnet' || STELLAR_NETWORK === 'public'
    ? 'Public Global Stellar Network ; September 2015'
    : 'Test SDF Network ; September 2015';

// Fail fast if the network and the RPC endpoint disagree (e.g. network flipped
// to mainnet but SOROBAN_RPC_URL left at its testnet default) — otherwise every
// signed transaction fails confusingly against the wrong network.
assertNetworkUrls(STELLAR_NETWORK, [{ label: 'SOROBAN_RPC_URL', url: SOROBAN_RPC_URL }]);

/** Plain http endpoints (local quickstart) need `allowHttp` on the rpc client. */
export const ALLOW_HTTP = SOROBAN_RPC_URL.startsWith('http://');

/**
 * Whether a registry contract id is configured at all. When it isn't, every
 * on-chain read is skipped rather than attempted-and-failed, so previews and
 * local dev never pay for a doomed RPC round trip.
 */
export function isRegistryConfigured(): boolean {
  return REGISTRY_CONTRACT_ID.length > 0;
}
