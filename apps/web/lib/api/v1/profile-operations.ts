import {
  getOperationsResult,
  getPagedOperations,
  getProfile,
  type OperationsResult,
  type Profile,
} from '../../profiles.ts';
import {
  encodeCursor,
  parseOperationsCursor,
  V1Error,
  type V1OperationsCursor,
  type V1OperationsKeysetCursor,
  type V1OperationsOffsetCursor,
} from './http.ts';

export {
  parseOperationsCursor,
  type V1OperationsCursor,
  type V1OperationsKeysetCursor,
  type V1OperationsOffsetCursor,
};

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
  cursor?: V1OperationsCursor | null;
  offset?: number;
  limit?: number;
}

export interface V1ProfileOperationsDeps {
  getProfile?: (handle: string) => Promise<Profile | null>;
  getPagedOperations?: (
    handle: string,
    pagination: any,
    limit: number,
  ) => Promise<{ data: any[]; total: number; hasMore?: boolean } | null>;
  getOperationsResult?: (handle: string) => Promise<OperationsResult>;
}

function toV1Operation(op: any): V1Operation {
  return {
    id: String(op.id),
    type: String(op.type),
    function: op.decodedFunction ?? op.decoded_function ?? op.function ?? null,
    contract: op.contractAddress ?? op.contract ?? null,
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
 * Prefers the database indexer query (pushing keyset cursor or skip/take to SQL and returning exact total).
 * Falls back to bounded Horizon operations when the database is unavailable, retaining
 * truncated and cap metadata while ensuring total is null and nextCursor never promises
 * records past the cap.
 */
export async function getV1ProfileOperations(
  handle: string,
  options: V1ProfileOperationsOptions = {},
  deps: V1ProfileOperationsDeps = {},
): Promise<V1ProfileOperationsResult> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));

  let cursor = options.cursor;
  if (!cursor && options.offset !== undefined) {
    if (
      typeof options.offset !== 'number' ||
      !Number.isInteger(options.offset) ||
      options.offset < 0
    ) {
      throw new V1Error('bad_request', 'Invalid cursor: offset must be a non-negative integer.', {
        parameter: 'cursor',
      });
    }
    cursor = { type: 'offset', offset: options.offset };
  }

  const pagedFetcher = deps.getPagedOperations ?? getPagedOperations;
  const paginationArg =
    cursor?.type === 'keyset'
      ? { cursor: { createdAt: cursor.createdAt, id: cursor.id }, limit }
      : cursor?.offset ?? 0;

  const paged = await pagedFetcher(handle, paginationArg as any, limit);

  if (paged) {
    const data = paged.data.map(toV1Operation);
    let nextCursor: string | null = null;
    if (cursor?.type === 'offset') {
      const currentOffset = cursor.offset;
      const hasMore = currentOffset + data.length < paged.total;
      nextCursor = hasMore ? encodeCursor({ offset: currentOffset + data.length }, 1) : null;
    } else {
      const hasMore =
        (paged as any).hasMore !== undefined
          ? (paged as any).hasMore
          : data.length === limit;
      const last = data[data.length - 1];
      nextCursor =
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id }, 2)
          : null;
    }

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

  if (cursor?.type === 'keyset') {
    const cursorKey = cursor;
    const afterKeyset = (op: any) => {
      const opDate = new Date(op.createdAt ?? op.created_at).getTime();
      const cursorDate = new Date(cursorKey.createdAt).getTime();
      if (opDate !== cursorDate) return opDate < cursorDate;
      return String(op.id) < String(cursorKey.id);
    };
    const matching = operations.filter(afterKeyset);
    const slice = matching.slice(0, limit);
    const data = slice.map(toV1Operation);
    const hasMore = matching.length > limit;
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id }, 2)
        : null;

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

  const offset = cursor?.type === 'offset' ? cursor.offset : 0;
  const slice = operations.slice(offset, offset + limit);
  const data = slice.map(toV1Operation);

  const hasMore = offset + slice.length < operations.length;
  const nextCursor = hasMore ? encodeCursor({ offset: offset + slice.length }, 1) : null;

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
