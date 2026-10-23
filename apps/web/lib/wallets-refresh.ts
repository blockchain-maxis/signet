/**
 * When the wallets page keeps itself fresh (#607).
 *
 * A wallet that was just linked shows "indexing…" until the indexer has scanned
 * it, which happens a little later and server-side. The page is rendered on the
 * server, so a user watching it would never see the badge clear without
 * reloading. While any wallet is still pending the page therefore re-fetches its
 * own data on a timer, and stops as soon as nothing is pending, or after a
 * bounded time so a stuck indexer cannot keep a tab polling forever.
 */

/** How often the list is refreshed while a wallet is pending. */
export const WALLETS_REFRESH_INTERVAL_MS = 10_000;

/** How long refreshing continues before giving up on a wallet that stays pending. */
export const WALLETS_REFRESH_MAX_MS = 5 * 60_000;

/**
 * Whether to refresh now, given whether any wallet is pending and how long the
 * page has been refreshing for.
 */
export function shouldRefreshWallets(anyPending: boolean, elapsedMs: number): boolean {
  return anyPending && elapsedMs < WALLETS_REFRESH_MAX_MS;
}
