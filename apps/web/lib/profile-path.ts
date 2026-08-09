import { HANDLE_MAX_LEN } from '@signet/types';

// Charset mirrors the on-chain registry via @signet/types; the bound is built
// from HANDLE_MAX_LEN so this can't drift from the contract independently.
const PROFILE_PATH_RE = new RegExp(`^/p/([a-z0-9_-]{1,${HANDLE_MAX_LEN}})$`);

/**
 * Extract the handle from a `/p/{handle}` path, or null for anything else.
 *
 * This is charset validation only — reserved handles still parse, because
 * `/p/api` is a real route that must resolve. Use `isClaimableHandle` from
 * `@signet/types` to decide whether a handle can actually be claimed.
 */
export function matchProfileHandle(pathname: string | null): string | null {
  return pathname?.match(PROFILE_PATH_RE)?.[1] ?? null;
}
