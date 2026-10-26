/**
 * `GET /api/v1/profiles/{handle}/contracts` (#631): the contracts a handle's
 * wallets deployed, for grant portals and job boards.
 *
 * The attribution is the profile page's own (`getProfileContracts`, #455):
 * `Contract` rows for any of the handle's wallets on the configured network,
 * or, with no database, the walk over the bound wallet's Horizon operations.
 * So the API and `/p/{handle}` never disagree. Newest deploy first, with the
 * address as the tiebreak, and a keyset cursor over both, so a page boundary
 * never repeats or skips a contract.
 *
 * A deployment that can answer from neither layer cannot enumerate
 * contracts, so it says so (`meta.source: "none"`, `truncated: true`) rather
 * than answering "no contracts".
 */
import { getProfileContractsWithDeps, type ProfileContractsDeps } from '../../profile-contracts.ts';
import { getProfile, type Profile } from '../../profiles.ts';
import { STELLAR_NETWORK } from '../../chain.ts';
import { encodeCursor, V1Error } from './http.ts';

export interface V1ProfileContract {
  address: string;
  deployer: string;
  deployedAt: string;
  deployTxHash: string;
  network: string;
  wasmHash: string | null;
  /** 'wasm' or 'stellar_asset' when the indexer has checked, else null. */
  contractType: string | null;
}

export interface V1ProfileContractsMeta {
  nextCursor: string | null;
  /** Contracts in the whole list; null when the list is known to be partial. */
  total: number | null;
  truncated: boolean;
  cap: number | null;
  /** 'database', 'horizon', or 'none' when no layer could enumerate. */
  source: 'database' | 'horizon' | 'none';
}

/** The keyset a cursor carries: the last row of the previous page. */
export interface V1ProfileContractsCursor {
  deployedAt: string;
  address: string;
}

export interface V1ProfileContractsDeps extends ProfileContractsDeps {
  getProfile?: (handle: string) => Promise<Profile | null>;
}

/** Newest deploy first; the address breaks a tie, ascending. */
function compare(a: V1ProfileContract, b: V1ProfileContract): number {
  if (a.deployedAt !== b.deployedAt) return a.deployedAt < b.deployedAt ? 1 : -1;
  return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
}

/** Whether row comes after the cursor's row in the list's order. */
function after(row: V1ProfileContract, cursor: V1ProfileContractsCursor): boolean {
  return compare(row, { ...row, ...cursor }) > 0;
}

export async function getV1ProfileContracts(
  handle: string,
  options: { cursor?: V1ProfileContractsCursor | null; limit?: number } = {},
  deps: V1ProfileContractsDeps = {},
): Promise<{ data: V1ProfileContract[]; meta: V1ProfileContractsMeta }> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  const network = deps.network ?? STELLAR_NETWORK;
  const listed = await getProfileContractsWithDeps(handle, deps);

  if (listed.source === 'none') {
    const profile = await (deps.getProfile ?? getProfile)(handle);
    if (!profile) {
      throw new V1Error('not_found', `No profile for handle '${handle}'.`, { handle });
    }
    return {
      data: [],
      meta: { nextCursor: null, total: null, truncated: true, cap: null, source: 'none' },
    };
  }

  const all = listed.contracts
    .map((c): V1ProfileContract => ({
      address: c.address,
      deployer: c.deployerPubkey,
      deployedAt: new Date(c.deployedAt).toISOString(),
      deployTxHash: c.deployTxHash,
      network,
      wasmHash: c.wasmHash,
      contractType: c.executableType,
    }))
    .sort(compare);
  const cursor = options.cursor;
  const rest = cursor ? all.filter((row) => after(row, cursor)) : all;
  const data = rest.slice(0, limit);
  const last = data[data.length - 1];
  const nextCursor =
    rest.length > limit && last
      ? encodeCursor<V1ProfileContractsCursor>({
          deployedAt: last.deployedAt,
          address: last.address,
        })
      : null;
  return {
    data,
    meta: {
      nextCursor,
      total: listed.truncated ? null : all.length,
      truncated: listed.truncated,
      cap: listed.cap,
      source: listed.source,
    },
  };
}
