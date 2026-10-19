import { ok, parseHandle, withV1 } from '../../../../../lib/api/v1/http.ts';
import { getV1Profile } from '../../../../../lib/api/v1/profile.ts';

export const runtime = 'nodejs';

export const PROFILE_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

type Ctx = { params: Promise<{ handle: string }> };

/**
 * GET /api/v1/profiles/{handle}
 *
 * Invalid handle → 400 `bad_request`; unknown handle → 404 `not_found`.
 */
function handle(req: Request, ctx: Ctx): Promise<Response> {
  return withV1(
    async () => {
      const { handle: raw } = await ctx.params;
      const { data, meta } = await getV1Profile(parseHandle(raw));
      return ok(data, meta);
    },
    { cache: PROFILE_CACHE_CONTROL },
  )(req);
}

export const GET = handle;
export const OPTIONS = handle;
