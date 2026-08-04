import { NextResponse, type NextRequest } from 'next/server';
import { RESERVED_HANDLES, isValidHandle } from '@signet/types';
import { buildCsp, generateNonce } from './lib/csp';

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
 *   handles     →  /handles (the public directory)
 *
 * Resolution order:
 *   1. If there's a usable subdomain, route by subdomain.
 *   2. Otherwise (Vercel previews, bare localhost), fall back to path-based
 *      routing so every surface is still reachable.
 *
 * Handles are validated (charset/length) before being routed to the profile
 * surface; anything malformed falls through to the marketing root. Existence
 * is enforced by the profile page itself (`notFound()`).
 */

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'signet.dev';

// Infrastructure subdomains that are not developer handles. These are a
// routing concern only — the contract has no opinion on them, so a wallet can
// still claim e.g. `www` on-chain even though it will never route here.
const INFRA_SUBDOMAINS = [
  'www',
  'status',
  'support',
  'mail',
  'blog',
  'static',
  'assets',
  'cdn',
] as const;

// Subdomains / first path segments that are NOT developer handles: everything
// the registry refuses to hand out, plus the infrastructure names above.
const RESERVED = new Set<string>([...RESERVED_HANDLES, ...INFRA_SUBDOMAINS]);

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

/**
 * Resolve the routing decision for a request: the internal path to rewrite to,
 * or `null` to pass the request through unchanged. Kept separate from the
 * response so the per-request CSP nonce is applied at a single exit point.
 */
function resolveRewriteTarget(req: NextRequest): string | null {
  const host = req.headers.get('host') ?? '';
  const { pathname } = req.nextUrl;
  const subdomain = getSubdomain(host);

  // ---- 1. Subdomain-based routing -----------------------------------------
  if (subdomain) {
    if (subdomain === 'app') {
      return `/app${pathname === '/' ? '' : pathname}`;
    }
    if (subdomain === 'docs') {
      return `/docs${pathname === '/' ? '' : pathname}`;
    }
    if (subdomain === 'api') {
      // tRPC handler lives at /api/trpc/* — pass requests straight through.
      return null;
    }
    if (subdomain === 'www' || RESERVED.has(subdomain)) {
      // Reserved but non-functional → marketing root.
      return null;
    }
    // Anything else is treated as a developer handle: {handle}.signet.dev
    if (isValidHandle(subdomain) && pathname === '/') {
      return `/p/${subdomain}`;
    }
    return null;
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
    first === 'handles' ||     // public handle directory
    first === 'api' ||
    first === '_next'
  ) {
    return null;
  }

  // `/@{handle}` → canonical profile
  if (first && first.startsWith('@')) {
    const handle = first.slice(1).toLowerCase();
    if (isValidHandle(handle)) {
      return `/p/${handle}`;
    }
    return null;
  }

  // `/{handle}` where the segment isn't a reserved app route → canonical profile
  if (first && !RESERVED.has(first) && segments.length === 1 && isValidHandle(first)) {
    return `/p/${first}`;
  }

  // Otherwise → marketing root.
  return null;
}

export function middleware(req: NextRequest): NextResponse {
  // Per-request nonce → CSP. Forwarding the policy on the *request* headers is
  // what lets Next.js stamp the nonce onto its own inline bootstrap/flight
  // scripts, so `script-src` needs no `'unsafe-inline'`.
  const nonce = generateNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== 'production' });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const target = resolveRewriteTarget(req);
  let response: NextResponse;
  if (target) {
    const url = req.nextUrl.clone();
    url.pathname = target;
    response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Skip Next internals and static assets; everything else hits the middleware.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
