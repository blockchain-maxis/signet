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
import {
  getProfileOperationsView,
  type ProfileOperationsView,
} from './profile-operations.ts';

export interface ProfilePageData {
  profile: Profile;
  operations: Operation[];
  /** The real number of operations backing the handle, not the page size. */
  total: number;
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
  getProfileOperationsView?: (handle: string) => Promise<ProfileOperationsView>;
  getProfileContracts?: (handle: string) => Promise<ProfileContractsResult>;
  getProfileStats?: (handle: string, operations: Operation[]) => Promise<ProfileStatsResult>;
  fetchHorizonOperations?: (wallet: string) => Promise<HorizonOperationsResult | null>;
  db?: ProfileContractsDb;
}

/**
 * Loads all data needed to render `/p/{handle}`.
 *
 * Resolves the profile first, then fetches the first operations page and the
 * contracts in parallel via `Promise.all`, and computes stats over everything
 * the operations layer returned rather than over the rendered page (#899).
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

  const getOperationsViewFn =
    deps.getProfileOperationsView ??
    ((h: string) => getProfileOperationsView(h, { getOperationsResult: getOpsFn }));

  const [operationsView, contractsResult] = await Promise.all([
    getOperationsViewFn(handle),
    getContractsFn(handle),
  ]);

  // Stats aggregate the whole result the operations layer returned, not just
  // the page rendered below: without a database they are computed from these
  // operations, so a 25-row page would undercount invocations and functions
  // and show the sample as an exact total (#899).
  const stats = await getStatsFn(handle, operationsView.statsOperations);

  return {
    profile,
    operations: operationsView.operations,
    total: operationsView.total,
    truncated: operationsView.truncated,
    cap: operationsView.cap,
    source: operationsView.source,
    contracts: contractsResult.contracts,
    contractsTruncated: contractsResult.truncated,
    contractsCap: contractsResult.cap,
    multiWallet: contractsResult.multiWallet,
    stats,
  };
}
