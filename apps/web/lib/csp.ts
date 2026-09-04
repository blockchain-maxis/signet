/**
 * Content-Security-Policy construction.
 *
 * The policy is built per request in `middleware.ts` so `script-src` can carry a
 * fresh **nonce** instead of `'unsafe-inline'`. Next.js injects that nonce onto
 * its own bootstrap/flight `<script>` tags when it finds it in the request's
 * CSP header, so inline scripts are allowed by nonce and everything else falls
 * to `'self'` — no `'unsafe-inline'` in `script-src`.
 *
 * `style-src` intentionally keeps `'unsafe-inline'`: the app relies on inline
 * React `style={}` and framer-motion styles, which cannot be nonced. Inline
 * styles are far lower risk than inline scripts (no script execution), so this
 * is an accepted, documented exception — dropping it would require refactoring
 * every inline style in the UI.
 *
 * The policy also **reports itself**. A CSP failure is invisible by design: the
 * browser blocks the request and the page renders with something quietly
 * missing, so without reporting the first signal of a bad policy is a user
 * complaint. Both reporting mechanisms are emitted, because no single one is
 * universally supported:
 *
 *   • `report-uri` — deprecated, but the only directive Firefox and Safari
 *     honour today.
 *   • `report-to` — the Reporting API replacement Chromium uses. It names a
 *     group defined by the `Reporting-Endpoints` response header, which
 *     `middleware.ts` sets alongside the policy.
 *
 * Both point at the same collector (`/api/csp-report` by default), so a browser
 * that supports either one is heard.
 */

/** Route that collects violation reports (see `app/api/csp-report/route.ts`). */
export const CSP_REPORT_PATH = '/api/csp-report';

/**
 * Reporting API group name shared by the `report-to` directive and the
 * `Reporting-Endpoints` header. The two must agree or Chromium silently drops
 * every report, so the name lives here once.
 */
export const CSP_REPORT_GROUP = 'csp-endpoint';

export interface CspOptions {
  /**
   * Development builds: Next's React Refresh / webpack HMR evaluate code with
   * `eval`, which needs `'unsafe-eval'`. Production never does.
   */
  dev?: boolean;
  /**
   * Where violations are reported. Defaults to the app's own collector; pass
   * an absolute URL to send them straight to an external collector instead.
   * Pass an empty string to build a policy with no reporting at all.
   */
  reportUri?: string;
  /**
   * Additional connect-src origins or hosts (e.g. for custom RPC / Horizon endpoints,
   * WalletConnect, or testing).
   */
  connectSrc?: string[] | string;
}

/**
 * Safely extracts the protocol + host (origin) from a URL string.
 * Strips paths, query parameters, hashes, and trailing slashes.
 * Returns null if the URL is invalid, empty, or has an opaque/unsupported origin.
 */
export function extractOrigin(url: string | undefined | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.origin && parsed.origin !== 'null') {
      return parsed.origin;
    }
  } catch {
    // Malformed URL, ignore gracefully
  }
  return null;
}

/**
 * Resolves all connect-src sources by combining defaults, configured environment
 * variables (RPC / Horizon / Explorer), and any explicit connect sources.
 */
export function resolveConnectSources(customSources?: string[] | string): string[] {
  const sources = new Set<string>(["'self'", 'https://*.stellar.org', 'https://stellar.expert']);

  // Extract origins from configured environment variables (RPC, Horizon, App URL)
  const envEndpoints = [
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL,
    process.env.SOROBAN_RPC_URL,
    process.env.NEXT_PUBLIC_HORIZON_URL,
    process.env.HORIZON_URL,
    process.env.STELLAR_HORIZON_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ];

  for (const endpoint of envEndpoints) {
    const origin = extractOrigin(endpoint);
    if (origin) {
      sources.add(origin);
    }
  }

  if (customSources) {
    const list = Array.isArray(customSources) ? customSources : [customSources];
    for (const item of list) {
      if (!item) continue;
      const origin = extractOrigin(item);
      if (origin) {
        sources.add(origin);
      } else {
        const trimmed = item.trim();
        if (trimmed) sources.add(trimmed);
      }
    }
  }

  return Array.from(sources);
}

/** Build the CSP header value for a request, binding `script-src` to `nonce`. */
export function buildCsp(
  nonce: string,
  { dev = false, reportUri = CSP_REPORT_PATH, connectSrc }: CspOptions = {},
): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    // Same-origin chunks load from /_next/static (covered by 'self'); inline
    // Next scripts are allowed by the nonce. No 'unsafe-inline'.
    ...(dev ? ["'unsafe-eval'"] : []),
  ].join(' ');

  const connectSources = resolveConnectSources(connectSrc).join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // See file header: inline styles can't be nonced, so 'unsafe-inline' stays
    // for style-src only. This is the documented, accepted exception.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https:",
    // connect-src covers the Stellar RPC / Horizon / Expert endpoints the client
    // calls, derived dynamically from configured environment variables.
    // The wallet modules registered today (Freighter, xBull, Albedo,
    // Rabet, Hana) talk through browser extensions and need nothing here. When
    // enabling a network-backed module in `lib/wallet.ts`, append its origins:
    //   • WalletConnect: https://*.walletconnect.com https://*.walletconnect.org
    //                    wss://*.walletconnect.com wss://*.walletconnect.org
    //   • LOBSTR:        https://*.lobstr.co
    `connect-src ${connectSources}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // See file header: both directives, same collector, so every engine reports.
    ...(reportUri ? [`report-uri ${reportUri}`, `report-to ${CSP_REPORT_GROUP}`] : []),
  ].join('; ');
}

/**
 * Value for the `Reporting-Endpoints` response header, which is what gives the
 * `report-to` group above an actual URL. The header takes a structured-fields
 * dictionary, whose values are quoted strings — an unquoted URL is a parse
 * error and the whole header is discarded.
 */
export function buildReportingEndpoints(reportUri: string = CSP_REPORT_PATH): string {
  return `${CSP_REPORT_GROUP}="${reportUri}"`;
}

/** A per-request nonce (base64), generated with the Edge-safe Web Crypto API. */
export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}
