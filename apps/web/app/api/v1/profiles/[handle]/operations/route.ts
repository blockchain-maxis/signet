import {
  ok,
  parseHandle,
  parseLimit,
  parseOperationsCursor,
  withV1,
} from '../../../../../../lib/api/v1/http.ts';
import { getV1ProfileOperations } from '../../../../../../lib/api/v1/profile-operations.ts';

export const runtime = 'nodejs';

export const OPERATIONS_CACHE_CONTROL = 'public, s-maxage=30, stale-while-revalidate=60';

type Ctx = { params: Promise<{ handle: string }> };

/**
 * GET /api/v1/profiles/{handle}/operations (#634)
 *
 * Cursor-paginated operations for a profile with honest completeness metadata.
 */
function handle(req: Request, ctx: Ctx): Promise<Response> {
  return withV1(
    async (request) => {
      const { handle: raw } = await ctx.params;
      const handle = parseHandle(raw);
      const url = new URL(request.url);
      const limit = parseLimit(url.searchParams.get('limit'), 25, 100);
      const cursor = parseOperationsCursor(url.searchParams.get('cursor'));

      const { data, meta } = await getV1ProfileOperations(handle, { cursor, limit });
      return ok(data, meta);
    },
    { cache: OPERATIONS_CACHE_CONTROL },
  )(req);
}

export const GET = handle;
export const OPTIONS = handle;
