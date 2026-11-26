import {
  getProfile,
  getOperationsResultWithDeps,
  getProfileStats,
  type Profile,
  type Operation,
  type OperationsSource,
  type ProfileStatsResult,
  type OperationsResult,
} from './profiles.ts';
import {
  getProfileContractsWithDeps,
  defaultHorizon,
  type ProfileContract,
  type ProfileContractsResult,
  type ProfileContractsDb,
} from './profile-contracts.ts';
import { fetchHorizonOperations, type HorizonOperationsResult } from './server/horizon.ts';

export interface ProfilePageData {
  profile: Profile;
  operations: Operation[];
  truncated: boolean;
  cap: number | null;
  source: OperationsSource;
  stats: ProfileStatsResult;
  contracts: ProfileContract[];
  contractsTruncated: boolean;
  contractsCap: number | null;
  multiWallet: boolean;
}

export interface ProfilePageDeps {
  getProfile?: (handle: string) => Promise<Profile | null>;
  getOperationsResult?: (handle: string) => Promise<OperationsResult>;
  getProfileContracts?: (handle: string) => Promise<ProfileContractsResult>;
  getProfileStats?: (handle: string, operations: Operation[]) => Promise<ProfileStatsResult>;
  fetchHorizonOperations?: (wallet: string) => Promise<HorizonOperationsResult | null>;
  db?: ProfileContractsDb;
}

/**
 * Loads all data needed to render `/p/{handle}`.
 *
 * Resolves the profile first, then fetches operations and contracts in parallel
 * via `Promise.all` before computing stats over the retrieved operations.
 * Returns `null` when the profile cannot be found.
 */
export async function loadProfilePageData(
  handle: string,
  deps: ProfilePageDeps = {},
): Promise<ProfilePageData | null> {
  const rawGetProfile = deps.getProfile ?? getProfile;
  const profileMemo = new Map<string, Promise<Profile | null>>();
  const getProfileFn = (h: string) => {
    let p = profileMemo.get(h);
    if (!p) {
      p = rawGetProfile(h);
      profileMemo.set(h, p);
    }
    return p;
  };

  const profile = await getProfileFn(handle);
  if (!profile) return null;

  const rawFetcher = deps.fetchHorizonOperations ?? fetchHorizonOperations;
  const horizonMemo = new Map<string, Promise<HorizonOperationsResult | null>>();
  const horizonFetcher = (w: string) => {
    let p = horizonMemo.get(w);
    if (!p) {
      p = rawFetcher(w);
      horizonMemo.set(w, p);
    }
    return p;
  };

  const getOpsFn =
    deps.getOperationsResult ??
    ((h: string) =>
      getOperationsResultWithDeps(h, {
        profile,
        fetchHorizonOperations: horizonFetcher,
      }));

  const getContractsFn =
    deps.getProfileContracts ??
    ((h: string) =>
      getProfileContractsWithDeps(h, {
        horizon: {
          boundWallet: async () => profile.wallet,
          listOperations: async (w: string) => {
            const res = await horizonFetcher(w);
            if (!res) return null;
            return {
              operations: res.operations.map((op) => ({
                type: op.type,
                function: op.function,
                transactionHash: op.transaction_hash ?? null,
                createdAt: op.created_at,
              })),
              truncated: res.truncated,
            };
          },
          getResultMetaXdr: defaultHorizon.getResultMetaXdr,
        },
        db: deps.db,
      }));

  const getStatsFn = deps.getProfileStats ?? getProfileStats;

  const [operationsResult, contractsResult] = await Promise.all([
    getOpsFn(handle),
    getContractsFn(handle),
  ]);

  const stats = await getStatsFn(handle, operationsResult.operations);

  return {
    profile,
    operations: operationsResult.operations,
    truncated: operationsResult.truncated,
    cap: operationsResult.cap,
    source: operationsResult.source,
    contracts: contractsResult.contracts,
    contractsTruncated: contractsResult.truncated,
    contractsCap: contractsResult.cap,
    multiWallet: contractsResult.multiWallet,
    stats,
  };
}
