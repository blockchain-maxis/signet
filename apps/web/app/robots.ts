import type { MetadataRoute } from 'next';
import { appUrl } from '@/lib/public-env';

/**
 * Rendered per request, not prerendered.
 *
 * `NEXT_PUBLIC_APP_URL` is inlined into client bundles at build time, and a
 * prerendered robots.txt bakes whatever the *build* environment had — which is
 * how a deployment whose runtime environment is correct can still serve
 * `Sitemap: http://localhost:3000/sitemap.xml`. Rendering on demand makes the
 * runtime value authoritative, which is the value the startup guard in
 * `instrumentation.ts` actually checked. The body is three lines of text; there
 * is nothing to save by baking it.
 */
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/app', '/api'] },
    sitemap: `${appUrl()}/sitemap.xml`,
  };
}
