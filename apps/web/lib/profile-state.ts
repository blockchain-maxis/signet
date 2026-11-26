import type { Profile } from './profiles.ts';

export type ProfileState = 'live' | 'archived' | 'no-wallet';

/**
 * Determines the display state of a profile for UI rendering.
 *
 * - `archived`: chain layer returned a profile with `archived: true` and empty wallet
 * - `no-wallet`: database layer returned a profile with no wallet (empty string)
 * - `live`: everything else (a valid on-chain or database binding with a wallet)
 *
 * The decision is pure and has no side effects, so the page and the OG image
 * can share it without duplicating logic.
 */
export function getProfileState(profile: Profile | null): ProfileState {
  if (!profile) return 'no-wallet';
  if (profile.archived === true) return 'archived';
  if (!profile.wallet) return 'no-wallet';
  return 'live';
}
