import { ok, parseHandle, withV1 } from '../../../../../lib/api/v1/http.ts';
import { getV1ResolveHandle, type V1ResolveHandleOptions } from '../../../../../lib/api/v1/resolve-handle.ts';

export const runtime = 'nodejs';

export const RESOLVE_CACHE_CONTROL = 'public, s-maxage=30';

type Ctx = { params: Promise<{ handle: string }> };

/**
 * GET /api/v1/resolve/{handle} (#644)
 *
 * Direct registry read with no database: which wallet does the Identity Registry say owns this handle?
 * - Bound: { data: { handle, wallet, network, registryContract } }
 * - Unbound: 404 not_found
 * - Registry unconfigured / simulation error: 503 unavailable with details.reason
 * - Cache: public, s-maxage=30
 */
export async function v1ResolveHandleData(handle: string, options: V1ResolveHandleOptions = {}) {
  return getV1ResolveHandle(handle, options);
}

function handle(req: Request, ctx: Ctx): Promise<Response> {
  return withV1(
    async () => {
      const { handle: raw } = await ctx.params;
      const cleanHandle = parseHandle(raw);
      const data = await v1ResolveHandleData(cleanHandle);
      return ok(data);
    },
    { cache: RESOLVE_CACHE_CONTROL },
  )(req);
}

export const GET = handle;
export const OPTIONS = handle;
