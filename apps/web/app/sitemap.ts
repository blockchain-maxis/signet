import type { MetadataRoute } from 'next';
import { listAllHandles } from '@/lib/profiles';
import { contractRoutes, profileRoutes, staticRoutes } from '@/lib/sitemap';
import { listAttributedContracts } from '@/lib/profile-contracts';
import { appUrl } from '@/lib/public-env';
import { logger } from '@/lib/logger';

/**
 * Rendered per request. Two reasons, both of which bite in production:
 * `NEXT_PUBLIC_APP_URL` is a build-time inline, so a prerendered sitemap can
 * publish the build environment's localhost default even when the runtime
 * environment is correct; and `listAllHandles()` reads the database and the
 * registry, so a baked sitemap silently omits every handle claimed after the
 * last deploy.
 */
export const dynamic = 'force-dynamic';

const MAX_SITEMAP_URLS = 45000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Resolved per call, not at module load: the startup guard in
  // `instrumentation.ts` is what makes this a real origin in production, and a
  // module-scope snapshot would be taken before it ever ran.
  const BASE = appUrl();
  const now = new Date();

  const statics = staticRoutes(now, BASE);
  const profiles = profileRoutes(await listAllHandles(), now, BASE);
  const contracts = contractRoutes(await listAttributedContracts(), BASE);

  const combined = [...statics, ...profiles, ...contracts];

  if (combined.length > MAX_SITEMAP_URLS) {
    logger.warn({ count: combined.length, limit: MAX_SITEMAP_URLS }, 'Sitemap URL limit exceeded');
    return combined.slice(0, MAX_SITEMAP_URLS);
  }

  return combined;
}
