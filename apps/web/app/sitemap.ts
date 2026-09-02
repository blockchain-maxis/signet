import type { MetadataRoute } from 'next';
import { listAllHandles } from '@/lib/profiles';
import { profileRoutes, staticRoutes } from '@/lib/sitemap';
import { appUrl } from '@/lib/public-env';

/**
 * Rendered per request. Two reasons, both of which bite in production:
 * `NEXT_PUBLIC_APP_URL` is a build-time inline, so a prerendered sitemap can
 * publish the build environment's localhost default even when the runtime
 * environment is correct; and `listAllHandles()` reads the database and the
 * registry, so a baked sitemap silently omits every handle claimed after the
 * last deploy.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Resolved per call, not at module load: the startup guard in
  // `instrumentation.ts` is what makes this a real origin in production, and a
  // module-scope snapshot would be taken before it ever ran.
  const BASE = appUrl();
  const now = new Date();
  return [...staticRoutes(now, BASE), ...profileRoutes(await listAllHandles(), now, BASE)];
}
