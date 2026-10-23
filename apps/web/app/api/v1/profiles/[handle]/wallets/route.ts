import { ok, parseHandle, withV1 } from '../../../../../../lib/api/v1/http.ts';
import { getHandleWallets } from '../../../../../../lib/server/account.ts';

export const runtime = 'nodejs';

export const WALLETS_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';

type Ctx = { params: Promise<{ handle: string }> };

/**
 * GET /api/v1/profiles/{handle}/wallets (#629)
 *
 * All wallets linked to a handle (primary sorted first).
 * Invalid handle -> 400 bad_request; unknown handle -> 404 not_found.
 */
function handle(req: Request, ctx: Ctx): Promise<Response> {
  return withV1(
    async () => {
      const { handle: raw } = await ctx.params;
      const { data, meta } = await getHandleWallets(parseHandle(raw));
      return ok(data, meta);
    },
    { cache: WALLETS_CACHE_CONTROL },
  )(req);
}

export const GET = handle;
export const OPTIONS = handle;
