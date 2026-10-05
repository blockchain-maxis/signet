import { NextRequest, NextResponse } from 'next/server';
import { getContractOperationsPage } from '@/lib/contract-activity';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * GET /api/p/[handle]/contract/[address]/operations?offset=0&limit=25&mine=1
 *
 * Returns a paginated slice of the calls made to a contract the handle
 * deployed, newest first. 404 when the handle does not own the contract or the
 * address is malformed; 503 when ownership could not be checked.
 *
 * `?mine=1` restricts the list to calls from the handle's own wallets.
 * Defaults to the first 25 rows; `limit` is clamped to 1-100.
 *
 * The response is the shape of `/api/p/[handle]/operations`. `meta.source` is
 * `none` (with an empty list) when there is no database: the per-contract call
 * index lives only there. The database counts every row, so `truncated` is
 * false.
 *
 *   {
 *     data: Operation[],
 *     meta: {
 *       total: number, offset: number, limit: number, hasMore: boolean,
 *       truncated: boolean, cap: number | null, source: 'database' | 'none'
 *     }
 *   }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ handle: string; address: string }> },
) {
  const limited = await enforceRateLimit(req, 'profile:contract-operations', LIMITS.read);
  if (limited) return limited;

  const { handle, address } = await params;
  const { status, body } = await getContractOperationsPage(
    handle,
    address,
    new URL(req.url).searchParams,
  );
  return NextResponse.json(body, { status });
}
