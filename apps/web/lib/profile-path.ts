// Mirrors the on-chain registry's handle charset (see middleware.ts / lib/profiles.ts).
const PROFILE_PATH_RE = /^\/p\/([a-z0-9_-]{1,32})$/;

/** Extract the handle from a `/p/{handle}` path, or null for anything else. */
export function matchProfileHandle(pathname: string | null): string | null {
  return pathname?.match(PROFILE_PATH_RE)?.[1] ?? null;
}
