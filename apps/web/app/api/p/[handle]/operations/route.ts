import { NextRequest, NextResponse } from 'next/server';
import { getOperationsResult, getPagedOperations } from '@/lib/profiles';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * GET /api/p/[handle]/operations?offset=0&limit=25
 *
 * Returns a paginated slice of operations for the given profile handle.
 * Defaults to the first 25 operations when offset/limit are omitted.
 *
 * `meta.total` is the number of operations retrieved, which is not the same as
 * the number that exist: the layer that answered reads a bounded window. When
 * `meta.truncated` is true, `meta.total` is a lower bound, `meta.cap` names the
 * limit that produced it, and a client must not present the list as complete.
 *
 * Response shape:
 *   {
 *     data: Operation[],
 *     meta: {
 *       total: number, offset: number, limit: number, hasMore: boolean,
 *       truncated: boolean, cap: number | null, source: OperationsSource
 *     }
 *   }
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const limited = await enforceRateLimit(_req, 'profile:operations', LIMITS.read);
  if (limited) return limited;

  const { handle } = await params;

  const url = new URL(_req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25),
  );

  // Prefer the database: it pushes offset/limit into the query (skip/take) and
  // counts the rest, so paging past the first page works and `total` is the
  // real number of operations rather than the size of a bounded read. Nothing
  // is capped on that path, so the record it answers with is complete.
  const paged = await getPagedOperations(handle, offset, limit);
  const page = paged
    ? {
        data: paged.data,
        total: paged.total,
        truncated: false,
        cap: null,
        source: 'database' as const,
      }
    : await fallbackPage(handle, offset, limit);

  const { data, total, truncated, cap, source } = page;

  return NextResponse.json({
    data,
    meta: {
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
      truncated,
      cap,
      source,
    },
  });
}

/**
 * Horizon / static-demo fallback for handles with no database-backed
 * operations. Those sources return a bounded array that is already in memory,
 * so the slice happens here — and the completeness `getOperationsResult`
 * reports travels with it, so a Horizon record cut off at its cap is still
 * declared partial rather than presented as a total.
 */
async function fallbackPage(handle: string, offset: number, limit: number) {
  const { operations, truncated, cap, source } = await getOperationsResult(handle);
  return {
    data: operations.slice(offset, offset + limit),
    total: operations.length,
    truncated,
    cap,
    source,
  };
}
