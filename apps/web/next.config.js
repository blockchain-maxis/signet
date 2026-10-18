// The Content-Security-Policy is set per request in `middleware.ts` (see
// `lib/csp.ts`) so `script-src` can carry a fresh nonce instead of
// `'unsafe-inline'`. The static, non-nonce headers below apply to every route,
// including static assets the middleware matcher skips.
const commonSecurityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const xFrameOptionsHeader = { key: 'X-Frame-Options', value: 'DENY' };

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are consumed as TypeScript source, so Next must
  // transpile them.
  transpilePackages: ['@signet/types', '@signet/sdk', '@signet/db', '@signet/spec'],
  async headers() {
    return [
      { source: '/:path*', headers: commonSecurityHeaders },
      {
        source: '/((?!p/[^/]+/contract/[^/]+/embed(?:/|$)).*)',
        headers: [xFrameOptionsHeader],
      },
    ];
  },
};

module.exports = nextConfig;
