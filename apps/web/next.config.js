// Content-Security-Policy. Allows the inline styles the app relies on (React
// `style={}` + framer-motion) and the Google Fonts CDN used in globals.css.
// connect-src covers the Stellar RPC/Horizon/Expert endpoints the client calls.
// NOTE: script-src keeps 'unsafe-inline' for Next's bootstrap scripts — tighten
// to a nonce-based policy (via middleware) as a follow-up.
//
// Optional Stellar Wallets Kit modules need extra connect-src origins. The
// modules registered today via `defaultModules()` (Freighter, xBull, Albedo,
// Rabet, Hana) talk to the page through browser extensions and need nothing
// here. Network-backed modules, however, would be silently blocked by the tight
// connect-src below — so when you register one in `apps/web/lib/wallet.ts`, add
// its origins to the connect-src directive:
//
//   • WalletConnect — relay + verify/explorer/rpc APIs (add all four):
//       https://*.walletconnect.com https://*.walletconnect.org
//       wss://*.walletconnect.com wss://*.walletconnect.org
//   • LOBSTR — signer + API (lobstr.co, api.lobstr.co):
//       https://*.lobstr.co
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  // Append the optional wallet-module origins documented above when enabling a
  // network-backed module, e.g. WalletConnect:
  //   https://*.walletconnect.com https://*.walletconnect.org
  //   wss://*.walletconnect.com wss://*.walletconnect.org
  // or LOBSTR: https://*.lobstr.co
  "connect-src 'self' https://*.stellar.org https://stellar.expert",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed as TypeScript source, so Next must
  // transpile them.
  transpilePackages: ['@signet/types', '@signet/ui', '@signet/sdk', '@signet/db'],
  // Fonts are loaded via @import in globals.css (not next/font), so there is no
  // build-time font download to optimize — the former `optimizeFonts` flag was
  // removed in Next 15.
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
