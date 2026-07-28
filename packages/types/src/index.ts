// Shared domain types for Signet. Kept framework-agnostic so every package
// (web, indexer, sdk, contracts tooling) can depend on a single source.

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
