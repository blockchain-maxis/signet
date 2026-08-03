/**
 * Horizon API client for fetching on-chain operations.
 *
 * Provides a best-effort fetch of `invoke_host_function` operations for a
 * bound wallet address directly from Horizon, with no database dependency.
 * Used as the middle tier in the operation resolution chain:
 *
 *   DB (indexer) → Horizon (this module) → static demo JSON → []
 *
 * All failures are caught and return null so callers degrade gracefully.
 * Responses are cached by Next.js fetch for 5 minutes (revalidate: 300).
 */

import type { Operation } from '../profiles.ts';
import { logger } from '../logger.ts';

/**
 * Horizon base URL. Prefers the explicit env var, then falls back to the
 * public testnet endpoint — matching how SOROBAN_RPC_URL is resolved in
 * directory.ts. Set HORIZON_URL (or NEXT_PUBLIC_HORIZON_URL) in production
 * to point at mainnet: https://horizon.stellar.org
 */
const HORIZON_URL =
  process.env.HORIZON_URL ??
  process.env.NEXT_PUBLIC_HORIZON_URL ??
  'https://horizon-testnet.stellar.org';

/** Maximum operations to retrieve per wallet (2 pages × 200). */
const MAX_RECORDS = 400;
/** Records per Horizon page (max allowed by Horizon is 200). */
const PAGE_LIMIT = 200;
/** Cache TTL in seconds — 5 minutes balances freshness vs. Horizon rate limits. */
const CACHE_TTL = 300;

/**
 * Minimal shape of a Horizon `invoke_host_function` operation record.
 * Only the fields we map into our `Operation` type are typed here.
 */
interface HorizonOperationRecord {
  id: string;
  type: string;
  type_i: number;
  function?: string;
  source_account?: string;
  created_at: string;
  transaction_hash?: string;
  transaction_successful?: boolean;
  asset_balance_changes?: Array<{
    asset_type: string;
    asset_code?: string;
    type: string;
    from?: string;
    to?: string;
    amount?: string;
  }>;
}

interface HorizonOperationsPage {
  _embedded: {
    records: HorizonOperationRecord[];
  };
  _links: {
    next?: { href: string };
  };
}

/**
 * Map a raw Horizon operation record to our `Operation` shape.
 * `decoded_function` is not available from Horizon directly — it comes from
 * the indexer's XDR decoding. We leave it undefined here; the UI falls back
 * to `function` (the raw HostFunctionType string) and then `invoke_contract`.
 */
function mapRecord(record: HorizonOperationRecord): Operation {
  return {
    id: record.id,
    type: record.type,
    function: record.function,
    decoded_function: undefined,
    source_account: record.source_account,
    created_at: record.created_at,
    transaction_hash: record.transaction_hash,
    transaction_successful: record.transaction_successful,
    asset_balance_changes: record.asset_balance_changes,
  };
}

/**
 * Fetch `invoke_host_function` operations for a Stellar account from Horizon.
 *
 * Returns an array of operations on success, or null on any failure (network
 * error, non-200 status, malformed JSON, invalid account). The caller is
 * expected to degrade gracefully when null is returned.
 *
 * @param wallet - The Stellar account ID (G…) to query.
 */
export async function fetchHorizonOperations(wallet: string): Promise<Operation[] | null> {
  // Basic sanity-check: Stellar account IDs start with G and are 56 chars.
  if (!wallet || !/^G[A-Z0-9]{55}$/.test(wallet)) return null;

  const base = HORIZON_URL.replace(/\/$/, '');
  const firstPageUrl = `${base}/accounts/${encodeURIComponent(wallet)}/operations?limit=${PAGE_LIMIT}&order=desc&include_failed=false`;

  try {
    const allRecords: HorizonOperationRecord[] = [];
    let nextUrl: string | null = firstPageUrl;
    let pages = 0;
    const maxPages = Math.ceil(MAX_RECORDS / PAGE_LIMIT);

    while (nextUrl && pages < maxPages) {
      const res = await fetch(nextUrl, {
        headers: { Accept: 'application/json' },
        // Next.js-specific: cache the response for CACHE_TTL seconds so
        // repeated SSR renders on the same server don't hammer Horizon.
        next: { revalidate: CACHE_TTL },
      });

      if (res.status === 404) {
        // Account not found on this network (e.g. unfunded testnet address).
        logger.info({ wallet, url: nextUrl }, 'horizon: account not found');
        return null;
      }

      if (!res.ok) {
        logger.warn({ wallet, status: res.status, url: nextUrl }, 'horizon: non-200 response');
        return null;
      }

      const page = (await res.json()) as HorizonOperationsPage;
      const records = page._embedded?.records ?? [];
      allRecords.push(...records);

      // Advance to the next page only if this one was full (implies more data).
      if (records.length < PAGE_LIMIT) break;
      nextUrl = page._links?.next?.href ?? null;
      pages++;
    }

    // Filter to only Soroban smart-contract invocations.
    const invocations = allRecords.filter((r) => r.type === 'invoke_host_function');

    logger.info(
      { wallet, total: allRecords.length, invocations: invocations.length },
      'horizon: fetched operations',
    );

    return invocations.map(mapRecord);
  } catch (err) {
    logger.error(
      { wallet, err: String(err) },
      'horizon: unexpected error fetching operations',
    );
    return null;
  }
}
