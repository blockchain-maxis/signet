import type { MetadataRoute } from 'next';
import { listAllHandles } from '@/lib/profiles';
import { profileRoutes, staticRoutes } from '@/lib/sitemap';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  return [...staticRoutes(now), ...profileRoutes(await listAllHandles(), now)];
}
