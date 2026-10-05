/**
 * @file Where the contract header reads its WASM hash from (#448).
 *
 * The header's one side effect, kept out of `lib/contract-header.ts` so that
 * module stays pure: the live instance read (`fetchWasmHash`, #433) and the
 * time the indexer last checked the indexed hash. Neither throws: a failure
 * is `null`, which the model renders as an honest "unavailable" or "as of".
 */
import { cache } from 'react';
import type { Network } from '@signet/types';
import { ALLOW_HTTP, SOROBAN_RPC_URL } from '../chain.ts';
import { logger } from '../logger.ts';

/** The header sits above every tab, so a slow RPC must not hold the page for long. */
const LIVE_READ_TIMEOUT_MS = 3_000;

/** Live WASM hash from the contract's instance entry; `null` on failure or a Stellar Asset Contract. */
export const loadLiveWasmHash = cache(
  async (address: string, network: Network): Promise<string | null> => {
    try {
      const { fetchWasmHash } = await import('@signet/spec/fetch');
      const result = await fetchWasmHash(address, {
        network,
        rpcUrl: SOROBAN_RPC_URL,
        allowHttp: ALLOW_HTTP,
        signal: AbortSignal.timeout(LIVE_READ_TIMEOUT_MS),
      });
      return result.type === 'wasm' ? result.wasmHash : null;
    } catch (error) {
      logger.warn({ address, error: String(error) }, 'live wasm hash read failed');
      return null;
    }
  },
);

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
