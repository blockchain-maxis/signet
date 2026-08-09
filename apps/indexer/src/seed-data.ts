import { DEMO_PROFILES } from '@signet/types';

export interface SeedProfile {
  handle: string;
  displayName: string;
  bio: string;
  wallets: string[];
}

/**
 * Curated Phase-1 demo profiles, derived from the single shared source in
 * `@signet/types` (`DEMO_PROFILES`) so the addresses live in exactly one place
 * and can't drift from the web app's `/p/{handle}` manifest
 * (`apps/web/lib/profiles.ts`). These are synthetic Stellar **testnet** accounts,
 * owned by no one, and are replaced by the on-chain Identity Registry in Phase 2.
 */
export const seedProfiles: SeedProfile[] = DEMO_PROFILES.map((profile) => ({
  handle: profile.handle,
  displayName: profile.name,
  bio: profile.bio,
  wallets: [profile.wallet],
}));
