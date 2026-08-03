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
 * React `style={}` and framer-motion styles (and the Google Fonts stylesheet),
 * which cannot be nonced. Inline styles are far lower risk than inline scripts
 * (no script execution), so this is an accepted, documented exception — dropping
 * it would require refactoring every inline style in the UI.
 */

export interface CspOptions {
  /**
   * Development builds: Next's React Refresh / webpack HMR evaluate code with
   * `eval`, which needs `'unsafe-eval'`. Production never does.
   */
  dev?: boolean;
}

/** Build the CSP header value for a request, binding `script-src` to `nonce`. */
export function buildCsp(nonce: string, { dev = false }: CspOptions = {}): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    // Same-origin chunks load from /_next/static (covered by 'self'); inline
    // Next scripts are allowed by the nonce. No 'unsafe-inline'.
    ...(dev ? ["'unsafe-eval'"] : []),
  ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // See file header: inline styles can't be nonced, so 'unsafe-inline' stays
    // for style-src only. This is the documented, accepted exception.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    // connect-src covers the Stellar RPC / Horizon / Expert endpoints the client
    // calls. The wallet modules registered today (Freighter, xBull, Albedo,
    // Rabet, Hana) talk through browser extensions and need nothing here. When
    // enabling a network-backed module in `lib/wallet.ts`, append its origins:
    //   • WalletConnect: https://*.walletconnect.com https://*.walletconnect.org
    //                    wss://*.walletconnect.com wss://*.walletconnect.org
    //   • LOBSTR:        https://*.lobstr.co
    "connect-src 'self' https://*.stellar.org https://stellar.expert",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** A per-request nonce (base64), generated with the Edge-safe Web Crypto API. */
export function generateNonce(): string {
  return btoa(crypto.randomUUID());
}
