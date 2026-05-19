import { NextResponse, type NextRequest } from 'next/server';

/**
 * Subdomain routing with a path-based fallback.
 *
 * Internal route-group → URL mapping (route groups like `(dashboard)` are
 * invisible in the URL, so each group's pages live under a real path segment):
 *
 *   marketing   →  /
 *   dashboard   →  /app, /app/wallets, /app/profile, /app/settings
 *   docs        →  /docs
 *   profile     →  /profile/{handle}, /profile/{handle}/contract/{address}
 *   trpc api    →  /api/trpc/*
 *
 * Resolution order:
 *   1. If there's a usable subdomain, route by subdomain.
 *   2. Otherwise (Vercel previews, bare localhost), fall back to path-based
 *      routing so every surface is still reachable.
 *
 * TODO(signet): once profiles exist, validate the handle (charset/length) and
 * check profile existence before rewriting to /profile/* — otherwise show a
 * proper 404 instead of rendering an empty profile.
 */

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'signet.dev';

// Subdomains / first path segments that are NOT developer handles.
const RESERVED = new Set([
  'app',
  'api',
  'docs',
  'www',
  'admin',
  'status',
  'support',
  'mail',
  'blog',
  'static',
  'assets',
  'cdn',
]);

/**
 * Extract the subdomain from a host header, or `null` when there isn't a
 * usable one (apex domain, bare `localhost`, or a `*.vercel.app` preview where
 * wildcard subdomains aren't available).
 */
function getSubdomain(host: string): string | null {
  const hostname = host.split(':')[0]?.toLowerCase() ?? '';

  if (hostname.endsWith('.vercel.app')) return null; // previews → path-based
  if (hostname === 'localhost') return null;

  if (hostname.endsWith(`.${ROOT_DOMAIN}`)) {
    const sub = hostname.slice(0, -(ROOT_DOMAIN.length + 1));
    return sub.length > 0 ? sub : null;
  }
  if (hostname === ROOT_DOMAIN) return null;

  // `*.localhost` works in modern browsers for local subdomain testing.
  if (hostname.endsWith('.localhost')) {
    const sub = hostname.slice(0, -'.localhost'.length);
    return sub.length > 0 ? sub : null;
  }

  return null;
}

function rewriteTo(req: NextRequest, pathname: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  return NextResponse.rewrite(url);
}

export function middleware(req: NextRequest): NextResponse {
  const host = req.headers.get('host') ?? '';
  const { pathname } = req.nextUrl;
  const subdomain = getSubdomain(host);

  // ---- 1. Subdomain-based routing -----------------------------------------
  if (subdomain) {
    if (subdomain === 'app') {
      return rewriteTo(req, `/app${pathname === '/' ? '' : pathname}`);
    }
    if (subdomain === 'docs') {
      return rewriteTo(req, `/docs${pathname === '/' ? '' : pathname}`);
    }
    if (subdomain === 'api') {
      // tRPC handler lives at /api/trpc/* — pass requests straight through.
      return NextResponse.next();
    }
    if (subdomain === 'www' || RESERVED.has(subdomain)) {
      // Reserved but non-functional → marketing root.
      return NextResponse.next();
    }
    // Anything else is treated as a developer handle: {handle}.signet.dev
    return rewriteTo(req, `/profile/${subdomain}${pathname === '/' ? '' : pathname}`);
  }

  // ---- 2. Path-based fallback ---------------------------------------------
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];

  // Already-correct internal paths: let them through unchanged.
  if (
    pathname === '/' ||
    first === 'app' ||
    first === 'docs' ||
    first === 'profile' ||
    first === 'p' ||           // demo profiles live at /p/{handle}
    first === 'how-it-works' || // static informational page
    first === 'api' ||
    first === '_next'
  ) {
    return NextResponse.next();
  }

  // `/@{handle}` → profile
  if (first && first.startsWith('@')) {
    const handle = first.slice(1);
    const rest = segments.slice(1);
    return rewriteTo(req, `/profile/${[handle, ...rest].join('/')}`);
  }

  // `/{handle}` where the segment isn't a reserved app route → profile
  if (first && !RESERVED.has(first)) {
    return rewriteTo(req, `/profile/${segments.join('/')}`);
  }

  // Otherwise → marketing root.
  return NextResponse.next();
}

export const config = {
  // Skip Next internals and static assets; everything else hits the middleware.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
