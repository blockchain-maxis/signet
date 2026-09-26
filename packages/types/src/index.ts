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

// Pairing audit trail — one event vocabulary for the web tier and the indexer.
export { PAIRING_EVENTS, PairingSecretLeakError, pairingEvent } from './pairing.ts';
export type {
  PairingEvent,
  PairingEventInput,
  PairingEventName,
  PairingOutcome,
} from './pairing.ts';

/** Allowed `Wallet.source` values, mirrored to Go for the CLI. */
export { WALLET_SOURCES, isWalletSource } from './wallet-source.ts';
export type { WalletSource } from './wallet-source.ts';

// How each provenance reads — one vocabulary for every surface that renders a
// binding, so a CLI link is never labelled as curated.
export { describeWalletSource } from './wallet.ts';
export type { WalletSourceDescriptor } from './wallet.ts';

// Canonical network types, normalization, and passphrase constants.
export { NETWORKS, isNetwork, normalizeNetwork, networkPassphrase } from './network.ts';
export type { Network } from './network.ts';

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
