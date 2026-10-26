import {
  ok,
  parseCursor,
  parseHandle,
  parseLimit,
  withV1,
} from '../../../../../../lib/api/v1/http.ts';
import {
  getV1ProfileContracts,
  type V1ProfileContractsCursor,
} from '../../../../../../lib/api/v1/profile-contracts.ts';

export const runtime = 'nodejs';

export const CONTRACTS_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

type Ctx = { params: Promise<{ handle: string }> };

/**
 * GET /api/v1/profiles/{handle}/contracts (#631)
 *
 * The contracts a handle's wallets deployed, newest first, keyset-paginated.
 */
function handle(req: Request, ctx: Ctx): Promise<Response> {
  return withV1(
    async (request) => {
      const { handle: raw } = await ctx.params;
      const handle = parseHandle(raw);
      const url = new URL(request.url);
      const limit = parseLimit(url.searchParams.get('limit'), 25, 100);
      const cursor = parseCursor<V1ProfileContractsCursor>(url.searchParams.get('cursor'));
      const { data, meta } = await getV1ProfileContracts(handle, { cursor, limit });
      return ok(data, meta);
    },
    { cache: CONTRACTS_CACHE_CONTROL },
  )(req);
}

export const GET = handle;
export const OPTIONS = handle;
