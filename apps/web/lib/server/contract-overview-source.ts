/**
 * @file Where the Overview tab reads its data from (#449).
 *
 * The page's two side effects, kept out of `lib/contract-overview.ts` so that
 * module stays pure: resolving a contract's interface (`getContractSpec` over
 * an in-memory LRU and the Postgres `ContractSpec` table) and reading the
 * newest `ContractSnapshot`. Neither throws: a failure becomes a value the
 * page renders (`SpecFailure`, or `null` for no snapshot).
 */
import { cache } from 'react';
import { LruSpecCache, type SpecCache, type SpecJson } from '@signet/spec';
import type { Network } from '@signet/types';
import { ALLOW_HTTP, SOROBAN_RPC_URL } from '../chain.ts';
import {
  classifySpecError,
  type ActivitySnapshotInput,
  type SpecInput,
  withFlattenedViews,
} from '../contract-overview.ts';
import { logger } from '../logger.ts';
import { PrismaSpecCache, SPEC_SCHEMA_VERSION, isStale } from './spec-store.ts';

/** Deadline for the whole interface resolution, so a slow RPC cannot stall the page. */
const RESOLVE_TIMEOUT_MS = 6_000;

const memory = new LruSpecCache<SpecJson>();

/**
 * Adapter from the Postgres store to the resolver's `SpecCache<SpecJson>`. A
 * stale row (older SDK or schema, §4.2) reads as a miss so it is re-extracted
 * and overwritten rather than served.
 */
function postgresCache(store = new PrismaSpecCache()): SpecCache<SpecJson> {
  return {
    async get(wasmHash) {
      const row = await store.get(wasmHash);
      if (!row || isStale(row)) return undefined;
      return row.specJson as SpecJson;
    },
    async set(wasmHash, spec) {
      await store.set(wasmHash, {
        schemaVersion: SPEC_SCHEMA_VERSION,
        sdkVersion: spec.sdkVersion,
        specJson: spec,
      });
    },
  };
}

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
  try {
    const { getContractSpec } = await import('@signet/spec/resolve');
    const resolved = await getContractSpec(request.address, {
      network: request.network,
      rpcUrl: SOROBAN_RPC_URL,
      allowHttp: ALLOW_HTTP,
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      caches: [memory, postgresCache()],
      ...(request.wasmHash ? { knownWasmHash: request.wasmHash } : {}),
      logger: {
        warn: (message, context) => logger.warn({ ...context }, message),
      },
    });
    return { kind: 'spec', spec: withFlattenedViews(resolved.spec) };
  } catch (error) {
    return {
      kind: 'failure',
      failure: classifySpecError(error, request.network),
    };
  }
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
