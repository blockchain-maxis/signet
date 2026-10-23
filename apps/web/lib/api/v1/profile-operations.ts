import {
  getOperationsResult,
  getPagedOperations,
  getProfile,
  type OperationsResult,
  type Profile,
} from '../../profiles.ts';
import { encodeCursor, V1Error } from './http.ts';

export interface V1Operation {
  id: string;
  type: string;
  function: string | null;
  contract: string | null;
  sourceAccount: string | null;
  createdAt: string;
  txHash: string | null;
  successful: boolean;
}

export interface V1OperationsMeta {
  nextCursor: string | null;
  total: number | null;
  truncated: boolean;
  cap: number | null;
  source: string;
}

export interface V1ProfileOperationsResult {
  data: V1Operation[];
  meta: V1OperationsMeta;
}

export interface V1ProfileOperationsOptions {
  offset?: number;
  limit?: number;
}

export interface V1ProfileOperationsDeps {
  getProfile?: (handle: string) => Promise<Profile | null>;
  getPagedOperations?: (
    handle: string,
    offset: number,
    limit: number,
  ) => Promise<{ data: any[]; total: number } | null>;
  getOperationsResult?: (handle: string) => Promise<OperationsResult>;
}

function toV1Operation(op: any): V1Operation {
  return {
    id: String(op.id),
    type: String(op.type),
    function: op.decodedFunction ?? op.decoded_function ?? op.function ?? null,
    contract: op.contract ?? null,
    sourceAccount: op.sourceAccount ?? op.source_account ?? null,
    createdAt:
      op.createdAt instanceof Date
        ? op.createdAt.toISOString()
        : typeof op.created_at === 'string'
          ? op.created_at
          : new Date(op.createdAt).toISOString(),
    txHash: op.transactionHash ?? op.transaction_hash ?? null,
    successful: Boolean(op.successful ?? op.transaction_successful ?? true),
  };
}

/**
 * Retrieve paginated operations for a profile with cursor paging.
 *
 * Prefers the database indexer query (pushing skip/take to SQL and returning exact total).
 * Falls back to bounded Horizon operations when the database is unavailable, retaining
 * truncated and cap metadata while ensuring total is null and nextCursor never promises
 * records past the cap.
 */
export async function getV1ProfileOperations(
  handle: string,
  options: V1ProfileOperationsOptions = {},
  deps: V1ProfileOperationsDeps = {},
): Promise<V1ProfileOperationsResult> {
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));

  const pagedFetcher = deps.getPagedOperations ?? getPagedOperations;
  const paged = await pagedFetcher(handle, offset, limit);

  if (paged) {
    const data = paged.data.map(toV1Operation);
    const hasMore = offset + data.length < paged.total;
    const nextCursor = hasMore ? encodeCursor({ offset: offset + data.length }) : null;

    return {
      data,
      meta: {
        nextCursor,
        total: paged.total,
        truncated: false,
        cap: null,
        source: 'database',
      },
    };
  }

  // Fallback path: verify profile exists first
  const profileFetcher = deps.getProfile ?? getProfile;
  const profile = await profileFetcher(handle);
  if (!profile) {
    throw new V1Error('not_found', `No profile for handle '${handle}'.`, { handle });
  }

  const opsFetcher = deps.getOperationsResult ?? getOperationsResult;
  const { operations, truncated, cap, source } = await opsFetcher(handle);

  const slice = operations.slice(offset, offset + limit);
  const data = slice.map(toV1Operation);

  const hasMore = offset + slice.length < operations.length;
  const nextCursor = hasMore ? encodeCursor({ offset: offset + slice.length }) : null;

  return {
    data,
    meta: {
      nextCursor,
      total: null,
      truncated,
      cap,
      source: source || 'horizon',
    },
  };
}
