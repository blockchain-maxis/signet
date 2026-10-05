/**
 * @file Where the Overview tab reads its data from (#449).
 *
 * The page's two side effects, kept out of `lib/contract-overview.ts` so that
 * module stays pure: resolving a contract's interface (`loadContractSpec`,
 * #464) and reading the newest `ContractSnapshot`. Neither throws: a failure becomes a value the
 * page renders (`SpecFailure`, or `null` for no snapshot).
 */
import { cache } from 'react';
import type { Network } from '@signet/types';
import type { ActivitySnapshotInput, SpecInput } from '../contract-overview.ts';
import { logger } from '../logger.ts';
import { loadContractSpec } from './contract-spec.ts';
import { PrismaSpecCache } from './spec-store.ts';

export interface OverviewSpecRequest {
  address: string;
  network: Network;
  /** Indexed WASM hash; `null` on the Horizon attribution path. */
  wasmHash: string | null;
}

/**
 * Resolve one contract's interface for the Overview. Cached per request so the
 * page and any sibling reader share one lookup.
 */
export const loadOverviewSpec = cache(async (request: OverviewSpecRequest): Promise<SpecInput> => {
  const result = await loadContractSpec(request);
  return result.ok
    ? { kind: 'spec', spec: result.spec }
    : { kind: 'failure', failure: result.failure };
});

/**
 * The newest snapshot for a contract, or `null` when there is none or no
 * database. `countedSince` is read when the column exists (#429) and is `null`
 * otherwise, which `summariseActivity` treats as "not measured".
 */
export const loadLatestSnapshot = cache(
  async (address: string, network: string): Promise<ActivitySnapshotInput | null> => {
    if (!process.env.DATABASE_URL) return null;
    try {
      const { prisma } = await import('@signet/db');
      const row = await prisma.contractSnapshot.findFirst({
        where: { contract: { address, network } },
        orderBy: { capturedAt: 'desc' },
      });
      if (!row) return null;
      const extra = row as typeof row & {
        countedSince?: Date | null;
        totalIsFloor?: boolean;
      };
      return {
        txCount24h: row.txCount24h,
        txCountTotal: row.txCountTotal,
        totalIsFloor: extra.totalIsFloor ?? false,
        countedSince: extra.countedSince ?? null,
        lastActivity: row.lastActivity,
        capturedAt: row.capturedAt,
      };
    } catch (error) {
      logger.warn({ address, error: String(error) }, 'contract snapshot lookup failed');
      return null;
    }
  },
);

/**
 * When the stored spec for a WASM hash was last extracted (#471), or `null`
 * when there is no stored row (no database, or served from memory before the
 * write landed). The provenance strip omits the time rather than guess it.
 */
export const loadSpecExtractedAt = cache(async (wasmHash: string): Promise<Date | null> => {
  try {
    const row = await new PrismaSpecCache().get(wasmHash);
    return row?.extractedAt ?? null;
  } catch (error) {
    logger.warn({ wasmHash, error: String(error) }, 'spec extractedAt lookup failed');
    return null;
  }
});
