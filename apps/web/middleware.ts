import { NextResponse, type NextRequest } from 'next/server';
import { CSP_REPORT_PATH, buildCsp, buildReportingEndpoints, generateNonce } from './lib/csp';
import { resolveRewriteTarget } from './lib/routing';

/**
 * Subdomain routing with a path-based fallback.
 *
 * Internal route-group → URL mapping (route groups like `(dashboard)` are
 * invisible in the URL, so each group's pages live under a real path segment):
 *
 *   marketing   →  /
 *   dashboard   →  /app, /app/wallets, /app/profile, /app/settings
 *   docs        →  /docs
 *   profile     →  /p/{handle}, /p/{handle}/contract/{address}[/{tab}]
 *                  (reachable as {handle}.signet.dev/…, /@{handle}/…, and
 *                  the legacy /profile/{handle} paths)
 *   trpc api    →  /api/trpc/*
 *   handles     →  /handles (the public directory)
 *
 * Resolution order:
 *   1. If there's a usable subdomain, route by subdomain.
 *   2. Otherwise (Vercel previews, bare localhost), fall back to path-based
 *      routing so every surface is still reachable.
 *
 * The decision table itself lives in `lib/routing.ts` (#446) — pure over
 * `(host, pathname)` and pinned case-by-case in `lib/routing.test.ts` — so
 * this file only wires it to the request and applies the per-request CSP
 * nonce at a single exit point. Handles are validated (charset/length)
 * before being routed to the profile surface; existence is enforced by the
 * pages themselves (`notFound()`).
 */

export function middleware(req: NextRequest): NextResponse {
  // Per-request nonce → CSP. Forwarding the policy on the *request* headers is
  // what lets Next.js stamp the nonce onto its own inline bootstrap/flight
  // scripts, so `script-src` needs no `'unsafe-inline'`.
  const nonce = generateNonce();
  // Absolute, so the policy reports to the host the page was actually served
  // from — a root-relative report target is resolved per document, which on the
  // handle subdomains would scatter reports across origins.
  const reportUri = new URL(CSP_REPORT_PATH, req.nextUrl.origin).toString();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== 'production', reportUri });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const target = resolveRewriteTarget(req.headers.get('host') ?? '', req.nextUrl.pathname);
  let response: NextResponse;
  if (target) {
    const url = req.nextUrl.clone();
    url.pathname = target;
    response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  } else {
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }

  response.headers.set('Content-Security-Policy', csp);
  // Gives the policy's `report-to` group a URL. Without this header Chromium
  // parses the directive and then has nowhere to send anything.
  response.headers.set('Reporting-Endpoints', buildReportingEndpoints(reportUri));
  return response;
}

export const config = {
  // Skip Next internals and static assets; everything else hits the middleware.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
