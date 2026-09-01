import type { MetadataRoute } from 'next';

export const SITEMAP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// Kept out of app/sitemap.ts so it can be unit tested: the route module imports
// the `@/lib` alias, which the node test runner does not resolve.
export function staticRoutes(now: Date, base = SITEMAP_BASE): MetadataRoute.Sitemap {
  return [
    { url: `${base}/`, lastModified: now, priority: 1 },
    { url: `${base}/handles`, lastModified: now, priority: 0.8 },
    { url: `${base}/how-it-works`, lastModified: now, priority: 0.7 },
    { url: `${base}/docs`, lastModified: now, priority: 0.5 },
  ];
}

export function profileRoutes(
  handles: string[],
  now: Date,
  base = SITEMAP_BASE,
): MetadataRoute.Sitemap {
  return handles.map((handle) => ({
    url: `${base}/p/${handle}`,
    lastModified: now,
    priority: 0.6,
  }));
}
