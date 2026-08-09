/**
 * Handle rules — the single source of truth for every off-chain surface.
 *
 * The on-chain Identity Registry is the real authority: `validate_handle` and
 * `is_reserved_handle` in `packages/contracts/identity-registry/src/lib.rs`
 * decide what `claim` accepts. This module mirrors those rules so client
 * surfaces can reject a handle *before* asking anyone to sign and pay for a
 * transaction that the contract would only reject with `HandleReserved`.
 *
 * Mirroring is enforced, not assumed: `handle.test.ts` parses lib.rs and fails
 * if the constants here drift from the contract. Change the contract first,
 * then this file — never the other way round.
 */

/** Maximum handle length, matching `MAX_HANDLE_LEN` in the contract. */
export const HANDLE_MAX_LEN = 32;

/**
 * Allowed handle charset, matching the byte check in `validate_handle`:
 * ASCII lowercase, digits, underscore, hyphen — 1 to `HANDLE_MAX_LEN` chars.
 */
export const HANDLE_PATTERN = /^[a-z0-9_-]{1,32}$/;

/**
 * Handles that collide with the web app's routes and are rejected by `claim`.
 * Mirrors `RESERVED_HANDLES` in the contract, which is the authoritative list.
 */
export const RESERVED_HANDLES = [
  'p',
  'api',
  'app',
  'admin',
  'docs',
  'handles',
  'how-it-works',
  'profile',
  'robots',
  'sitemap',
] as const;

export type ReservedHandle = (typeof RESERVED_HANDLES)[number];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_HANDLES);

/** True when `handle` satisfies the contract's length and charset rules. */
export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/**
 * True when `handle` is reserved for an app route. Matching is exact and
 * case-sensitive, mirroring the contract's byte comparison — `apps` and
 * `profiles` are not reserved even though `app` and `profile` are.
 */
export function isReservedHandle(handle: string): boolean {
  return RESERVED_SET.has(handle);
}

/**
 * True when `claim` would accept `handle` — valid charset/length *and* not
 * reserved. Use this for any "is this handle available?" affordance; use
 * {@link isValidHandle} only when you mean charset validity alone (for example
 * parsing a handle out of a URL, where reserved names still need to resolve).
 */
export function isClaimableHandle(handle: string): boolean {
  return isValidHandle(handle) && !isReservedHandle(handle);
}
