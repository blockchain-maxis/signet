/**
 * @file Where the contract header reads its WASM hash from (#448).
 *
 * The header's one side effect, kept out of `lib/contract-header.ts` so that
 * module stays pure: the live instance read (`fetchWasmHash`, #433) and the
 * time the indexer last checked the indexed hash. Neither throws: a failure
 * is `null` (or an unread instance), which the model renders as an honest
 * "unavailable" or "as of".
 */
import { cache } from 'react';
import type { Network } from '@signet/types';
import { ALLOW_HTTP, SOROBAN_RPC_URL } from '../chain.ts';
import { logger } from '../logger.ts';
import {
  LIVE_INSTANCE_TTL_SECONDS,
  contractTag,
  nextDataCache,
  type DataCache,
} from './contract-cache.ts';

/** The header sits above every tab, so a slow RPC must not hold the page for long. */
const LIVE_READ_TIMEOUT_MS = 3_000;

/** What the live instance read found. */
export interface LiveInstance {
  /** Hash from the instance entry; `null` on failure or a Stellar Asset Contract. */
  wasmHash: string | null;
  /** The instance entry's TTL has passed: it must be restored before the contract can be invoked. */
  archived: boolean;
}

const UNREAD: LiveInstance = { wasmHash: null, archived: false };

/** The slice of `fetchWasmHash` the loader needs; tests inject a stub. */
type FetchWasmHash = (
  address: string,
  opts: { network: Network; rpcUrl: string; allowHttp?: boolean; signal?: AbortSignal },
) => Promise<
  | { type: 'wasm'; wasmHash: string; archived?: true }
  | { type: 'stellar_asset'; archived?: true }
>;

export interface LiveInstanceDeps {
  fetchWasmHash?: FetchWasmHash;
  dataCache?: DataCache;
}

/**
 * Live instance read: the WASM hash and whether the instance has expired.
 * Remembered for a minute across requests (#458): an upgrade changes the hash
 * without changing the address, so this is the one value that can go stale, and
 * a minute bounds it (Next's data cache serves one stale read after expiry while
 * it refreshes). A failed read is unread (`null`, not archived) and is not
 * remembered, so a blip is not served back after the RPC recovers; a Stellar
 * Asset Contract is a real answer, so it is. Never throws.
 */
export function createLiveInstanceLoader(
  deps: LiveInstanceDeps = {},
): (address: string, network: Network) => Promise<LiveInstance> {
  const dataCache = deps.dataCache ?? nextDataCache;
  return (address, network) =>
    dataCache.remember<LiveInstance>({
      key: ['contract-live-instance', network, address],
      tags: [contractTag(address)],
      ttlSeconds: LIVE_INSTANCE_TTL_SECONDS,
      compute: async () => {
        try {
          const fetchWasmHash =
            deps.fetchWasmHash ?? (await import('@signet/spec/fetch')).fetchWasmHash;
          const result = await fetchWasmHash(address, {
            network,
            rpcUrl: SOROBAN_RPC_URL,
            allowHttp: ALLOW_HTTP,
            signal: AbortSignal.timeout(LIVE_READ_TIMEOUT_MS),
          });
          return {
            value: {
              wasmHash: result.type === 'wasm' ? result.wasmHash : null,
              archived: result.archived === true,
            },
            cache: true,
          };
        } catch (error) {
          logger.warn({ address, error: String(error) }, 'live wasm hash read failed');
          return { value: UNREAD, cache: false };
        }
      },
    });
}

/** One read per render (React `cache`), and at most one per minute per contract across renders. */
export const loadLiveInstance = cache(createLiveInstanceLoader());

/** When the indexer last checked the indexed hash, or `null` without a database or row. */
export const loadIndexedAsOf = cache(async (address: string): Promise<string | null> => {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { prisma } = await import('@signet/db');
    const row = await prisma.contract.findUnique({
      where: { address },
      select: { wasmHashCheckedAt: true },
    });
    return row?.wasmHashCheckedAt?.toISOString() ?? null;
  } catch (error) {
    logger.warn({ address, error: String(error) }, 'indexed wasm hash date lookup failed');
    return null;
  }
});
