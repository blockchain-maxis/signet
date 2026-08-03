import type { MetadataRoute } from 'next';
import { listAllHandles } from '@/lib/profiles';

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE}/`, lastModified: now, priority: 1 },
    { url: `${BASE}/how-it-works`, lastModified: now, priority: 0.7 },
    { url: `${BASE}/docs`, lastModified: now, priority: 0.5 },
  ];
  const profiles = (await listAllHandles()).map((handle) => ({
    url: `${BASE}/p/${handle}`,
    lastModified: now,
    priority: 0.6,
  }));
  return [...staticRoutes, ...profiles];
}
