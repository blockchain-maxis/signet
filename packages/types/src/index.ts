// TODO(signet): define the shared domain types as features land:
// Profile, Wallet, Contract, Attestation, ActivitySnapshot, etc.
// For now these placeholders give downstream packages something to import.

export type Handle = string;

/** A Stellar account or contract address (G... / C...). */
export type StellarAddress = string;

export interface PlaceholderProfile {
  id: string;
  handle: Handle;
  createdAt: string;
}

export const SIGNET_TYPES_VERSION = '0.0.0';
