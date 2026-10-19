import type { Network } from '@signet/types';
import { STELLAR_NETWORK } from '../../chain.ts';
import { getProfileContracts, type ProfileContractsResult } from '../../profile-contracts.ts';
import {
  getOperationsResult,
  getProfile,
  getProfileStats,
  type OperationsResult,
  type Profile,
  type ProfileStatsResult,
} from '../../profiles.ts';
import { V1Error } from './http.ts';

/**
 * `GET /api/v1/profiles/{handle}`: the stable, v1 view of a profile.
 *
 * Deliberately narrower than the tRPC `profile.byHandle`: no Horizon
 * `operations` array (they have their own paginated endpoint) and no
 * heuristic `reputation` score (a number Signet cannot explain or defend, and
 * one that could not be removed from v1 without a v2).
 */
export interface V1ProfileData {
  handle: string;
  displayName: string | null;
  bio: string | null;
  primaryWallet: string | null;
  joinedAt: string | null;
  network: Network;
  archived: boolean;
  counts: { contracts: number; wallets: number; invocations: number };
  /** True when a retention window or read cap bounded any of `counts`. */
  countsAreLowerBounds: boolean;
}

export interface V1ProfileMeta {
  network: Network;
  source: Profile['source'];
}

/** Seams for tests: the DB / chain / Horizon reads this endpoint composes. */
export interface V1ProfileDeps {
  network?: Network;
  getProfile?: (handle: string) => Promise<Profile | null>;
  getOperationsResult?: (handle: string) => Promise<OperationsResult>;
  getProfileStats?: (
    handle: string,
    ops: OperationsResult['operations'],
  ) => Promise<ProfileStatsResult>;
  getProfileContracts?: (handle: string) => Promise<ProfileContractsResult>;
  /** Wallets linked to the handle in the database, or null when unknown. */
  countWallets?: (handle: string) => Promise<number | null>;
}

async function dbWalletCount(handle: string): Promise<number | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { prisma } = await import('@signet/db');
    return await prisma.wallet.count({ where: { profile: { handle } } });
  } catch {
    return null;
  }
}

/** The profile's `joined` is a `YYYY-MM-DD` date (or empty); v1 serves an ISO-8601 instant. */
function toJoinedAt(joined: string): string | null {
  if (!joined) return null;
  const ms = Date.parse(joined.length === 10 ? `${joined}T00:00:00.000Z` : joined);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Resolve a (already validated, lowercased) handle to its v1 profile.
 * Throws `V1Error('not_found')` when no layer knows the handle.
 */
export async function getV1Profile(
  handle: string,
  deps: V1ProfileDeps = {},
): Promise<{ data: V1ProfileData; meta: V1ProfileMeta }> {
  const network = deps.network ?? STELLAR_NETWORK;
  const profile = await (deps.getProfile ?? getProfile)(handle);
  if (!profile) {
    throw new V1Error('not_found', `No profile for handle '${handle}'.`, { handle });
  }

  const [opsResult, contracts, dbWallets] = await Promise.all([
    (deps.getOperationsResult ?? getOperationsResult)(handle),
    (deps.getProfileContracts ?? getProfileContracts)(handle),
    (deps.countWallets ?? dbWalletCount)(handle),
  ]);
  const stats = await (deps.getProfileStats ?? getProfileStats)(handle, opsResult.operations);

  const wallets = dbWallets ?? (profile.wallet ? 1 : 0);
  // An exact aggregate is only exact for its retention window, which is itself
  // a floor on lifetime activity. Otherwise the count inherits any read cap.
  const invocationsBounded = stats.exact ? stats.retentionWindowDays !== null : opsResult.truncated;

  return {
    data: {
      handle,
      displayName: profile.name && profile.name !== handle ? profile.name : null,
      bio: profile.bio || null,
      primaryWallet: profile.wallet || null,
      joinedAt: toJoinedAt(profile.joined),
      network,
      archived: profile.archived === true,
      counts: { contracts: contracts.contracts.length, wallets, invocations: stats.invocations },
      countsAreLowerBounds: invocationsBounded || contracts.truncated,
    },
    meta: { network, source: profile.source },
  };
}
