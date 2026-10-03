import { RESERVED_HANDLES, isValidHandle } from '@signet/types';
import { CONTRACT_TABS } from './contract-tabs.ts';

/**
 * Pure routing decisions for the middleware (#446): subdomain extraction and
 * rewrite-target resolution over `(host, pathname)` — no `NextRequest`, no
 * `next/server` import, so the whole decision table is unit-testable
 * (`routing.test.ts` pins every case, the middleware only wires it up).
 *
 * Behaviour for pre-existing paths is unchanged; what #446 adds is nested
 * contract paths on both alternate surfaces:
 *
 *   {handle}.signet.dev/contract/{address}[/{tab}]  →  /p/{handle}/contract/{address}[/{tab}]
 *   /@{handle}/contract/{address}[/{tab}]           →  same
 *
 * rewritten only when the handle, the address and (when present) the tab all
 * validate — anything else keeps today's behaviour rather than inventing a
 * rewrite for a malformed URL.
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

/** The contract page's child segments (#445) — the only tabs that route. */
const CONTRACT_TAB_SEGMENTS = new Set(
  CONTRACT_TABS.map((t) => t.segment).filter((s): s is string => s !== null),
);

/**
 * Shape of a Soroban contract address: C-prefixed StrKey, 56 base32 chars.
 *
 * Deliberately NOT `isContractAddress` from `./contract-address.ts`: that
 * validates the StrKey checksum via `@stellar/stellar-sdk`, which imports
 * `node:crypto` — and this module is bundled into the middleware, which runs
 * on the Edge runtime where native Node modules don't exist (importing it
 * takes the whole site down, not just contract paths). The shape check is
 * enough to decide *routing*; a well-shaped address with a bad checksum
 * rewrites to the contract page, whose layout 404s it via the attribution
 * check (`invalid` status) — the same "the page enforces existence" split
 * the handle routes use.
 */
const CONTRACT_ADDRESS_SHAPE = /^C[A-Z2-7]{55}$/;

/**
 * Shape of a Soroban function name (#475): the permalink's `{name}` segment.
 * Soroban symbols are `[A-Za-z0-9_]` and at most 32 characters; anything else
 * cannot be a function, so it is not rewritten (the page itself 404s unknown
 * names, this only keeps junk off the internal route).
 */
const FUNCTION_NAME_SHAPE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * Extract the subdomain from a host header, or `null` when there isn't a
 * usable one (apex domain, bare `localhost`, or a `*.vercel.app` preview where
 * wildcard subdomains aren't available).
 */
export function getSubdomain(host: string): string | null {
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
 * `/contract/{address}`, `/contract/{address}/{tab}` or
 * `/contract/{address}/functions/{name}` relative to a profile:
 * the suffix to append to `/p/{handle}`, or `null` when the segments are not
 * a valid contract path (wrong shape, bad address, unknown tab).
 */
function contractSuffix(segments: string[]): string | null {
  if (segments[0] !== 'contract') return null;
  const address = segments[1];
  if (!address || !CONTRACT_ADDRESS_SHAPE.test(address)) return null;
  if (segments.length === 2) return `/contract/${address}`;
  const tab = segments[2];
  if (segments.length === 3 && tab && CONTRACT_TAB_SEGMENTS.has(tab)) {
    return `/contract/${address}/${tab}`;
  }
  // `/contract/{address}/functions/{name}` — the per-function permalink (#475).
  const name = segments[3];
  if (segments.length === 4 && tab === 'functions' && name && FUNCTION_NAME_SHAPE.test(name)) {
    return `/contract/${address}/functions/${name}`;
  }
  return null;
}

/**
 * Resolve the routing decision for a request: the internal path to rewrite
 * to, or `null` to pass the request through unchanged.
 */
export function resolveRewriteTarget(host: string, pathname: string): string | null {
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
    if (isValidHandle(subdomain)) {
      if (pathname === '/') return `/p/${subdomain}`;
      // Nested contract docs on the handle subdomain (#446).
      const suffix = contractSuffix(pathname.split('/').filter(Boolean));
      if (suffix) return `/p/${subdomain}${suffix}`;
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
    first === 'p' || // public profiles live at /p/{handle}
    first === 'how-it-works' || // static informational page
    first === 'handles' || // public handle directory
    // The CLI's approval page. Without this, `link` is a valid handle shape,
    // so /link?code=… is rewritten to /p/link and 404s — which makes the URL
    // `signet link` prints unreachable on any deployment running this
    // middleware, while working locally where nothing rewrites it.
    //
    // It is NOT in RESERVED_HANDLES: that list mirrors the identity-registry
    // contract, which is immutable, so "link" can still be claimed on-chain.
    // A profile with that handle stays reachable at /p/link and /@link; only
    // the bare /link belongs to the approval page.
    first === 'link' ||
    first === 'api' ||
    first === '_next'
  ) {
    return null;
  }

  // `/@{handle}` → canonical profile, `/@{handle}/contract/…` → its docs (#446)
  if (first && first.startsWith('@')) {
    const handle = first.slice(1).toLowerCase();
    if (!isValidHandle(handle)) return null;
    if (segments.length === 1) return `/p/${handle}`;
    const suffix = contractSuffix(segments.slice(1));
    if (suffix) return `/p/${handle}${suffix}`;
    return null;
  }

  // `/{handle}` where the segment isn't a reserved app route → canonical profile
  if (first && !RESERVED.has(first) && segments.length === 1 && isValidHandle(first)) {
    return `/p/${first}`;
  }

  // Otherwise → marketing root.
  return null;
}
