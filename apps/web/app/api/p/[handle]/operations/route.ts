import { NextRequest, NextResponse } from 'next/server';
import { getOperations } from '@/lib/profiles';

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
  const { handle } = await params;

  const url = new URL(_req.url);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '25', 10) || 25));

  const allOperations = await getOperations(handle);
  const total = allOperations.length;
  const slice = allOperations.slice(offset, offset + limit);

  return NextResponse.json({
    data: slice,
    meta: {
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    },
  });
}
