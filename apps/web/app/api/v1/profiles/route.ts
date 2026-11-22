import { ok, parseCursor, parseLimit, withV1 } from '../../../../lib/api/v1/http.ts';
import {
  getV1ProfilesList,
  type V1ProfilesListCursor,
} from '../../../../lib/api/v1/profiles-list.ts';

export const runtime = 'nodejs';

/** The "profile and activity data" class of docs/API_V1.md. */
export const PROFILES_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=60';

/**
 * GET /api/v1/profiles (#969)
 *
 * The handles this deployment can serve, in handle order, keyset-paginated.
 * An answer from a fallback layer, or from none, is not cached.
 */
function handle(req: Request): Promise<Response> {
  return withV1(
    async (request) => {
      const url = new URL(request.url);
      const limit = parseLimit(url.searchParams.get('limit'), 25, 100);
      const cursor = parseCursor<V1ProfilesListCursor>(url.searchParams.get('cursor'));
      const { data, meta, degraded } = await getV1ProfilesList({ cursor, limit });
      return ok(data, meta, degraded ? { headers: { 'Cache-Control': 'no-store' } } : undefined);
    },
    { cache: PROFILES_CACHE_CONTROL },
  )(req);
}

export const GET = handle;
export const OPTIONS = handle;
