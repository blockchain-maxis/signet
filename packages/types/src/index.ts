// Shared domain types for Signet. Kept framework-agnostic so every package
// (web, indexer, sdk, contracts tooling) can depend on a single source.

// Handle validity and reservation rules, mirrored from the on-chain registry.
export {
  HANDLE_MAX_LEN,
  HANDLE_PATTERN,
  RESERVED_HANDLES,
  isClaimableHandle,
  isReservedHandle,
  isValidHandle,
} from './handle.ts';
export type { ReservedHandle } from './handle.ts';

/** Allowed `Wallet.source` values, mirrored to Go for the CLI. */
export { WALLET_SOURCES, isWalletSource } from './wallet-source.ts';
export type { WalletSource } from './wallet-source.ts';

export type Handle = string;

/** A Stellar account or contract address (G… / C…). */
export type StellarAddress = string;

/** Public-facing profile record. */
export interface SignetProfile {
  handle: Handle;
  name: string;
  bio: string;
  wallet: StellarAddress;
  joined: string;
}

/** Aggregate on-chain stats shown on a profile. */
export interface ProfileStats {
  invocations: number;
  uniqueFunctions: number;
  /** 0–100 heuristic reputation score from observed activity. */
  reputation: number;
}

/** Response shape returned by `profile.byHandle`. */
export interface ProfileResponse {
  handle: Handle;
  profile: SignetProfile;
  stats: ProfileStats;
}

/** A single handle ↔ wallet binding from the on-chain registry. */
export interface RegistryEntry {
  handle: Handle;
  wallet: StellarAddress;
}

/** Response shape returned by `registry.count`. */
export interface RegistryCount {
  count: number;
}

export const SIGNET_TYPES_VERSION = '0.1.0';

/**
 * Curated Phase-1 demo profiles — the single source of truth for the synthetic
 * personas shown before the on-chain Identity Registry replaces curation in
 * Phase 2.
 *
 * These are synthetic Stellar **testnet** accounts, generated for the demo and
 * owned by no one, so no invented persona is attributed to a real wallet. Both
 * the web app (the static `/p/{handle}` manifest, `apps/web/lib/profiles.ts`)
 * and the indexer seed (`apps/indexer/src/seed-data.ts`) derive from this array,
 * so the addresses live in exactly one place and can't drift.
 */
export const DEMO_PROFILES: readonly SignetProfile[] = [
  {
    handle: 'aquawolf',
    name: 'Aqua Wolf',
    wallet: 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD',
    bio: 'Demo persona · Soroban DeFi builder exercising Blend-style collateral flows on testnet.',
    joined: '2026-03-04',
  },
  {
    handle: 'sorobuilder',
    name: 'Soro Builder',
    wallet: 'GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ',
    bio: 'Demo persona · DEX trader running Soroswap-style swaps on testnet.',
    joined: '2026-02-19',
  },
  {
    handle: 'stellardev',
    name: 'Stellar Dev',
    wallet: 'GBNOH2NKPHZYOWF2LHLSZ27R54NMCH66KPBEEY6MCE4FM5V6PNZVHZKL',
    bio: 'Demo persona · token operations and transfers on Stellar testnet.',
    joined: '2026-01-27',
  },
];
