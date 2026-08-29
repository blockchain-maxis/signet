import { NextRequest, NextResponse } from 'next/server';
import { getOperations, getPagedOperations } from '@/lib/profiles';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * GET /api/p/[handle]/operations?offset=0&limit=25
 *
 * Returns a paginated slice of operations for the given profile handle.
 * Defaults to the first 25 operations when offset/limit are omitted.
 *
 * Response shape:
 *   { data: Operation[], meta: { total: number, offset: number, limit: number, hasMore: boolean } }
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ handle: string }> },
) {
  const limited = await enforceRateLimit(_req, 'profile:operations', LIMITS.read);
  if (limited) return limited;

  const { handle } = await params;

  const url = new URL(_req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25));

  // Prefer the database: it pushes offset/limit into the query (skip/take)
  // and a real count, so paging past the first page still works and `total`
  // reflects the actual number of operations, not a pre-truncated sample.
  const paged = await getPagedOperations(handle, offset, limit);
  const { data, total } = paged ?? (await fallbackPage(handle, offset, limit));

  return NextResponse.json({
    data,
    meta: {
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    },
  });
}

/**
 * Horizon / static-demo fallback for handles with no database-backed
 * operations. Both of those sources already return a small, bounded array
 * (Horizon capped client-side, demo JSON inherently tiny), so slicing it in
 * memory here is honest: `total` is the real size of that bounded set, not a
 * truncated page of a much larger one.
 */
async function fallbackPage(handle: string, offset: number, limit: number) {
  const all = await getOperations(handle);
  return { data: all.slice(offset, offset + limit), total: all.length };
}
