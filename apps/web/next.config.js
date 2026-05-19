/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source, so Next must
  // transpile them.
  transpilePackages: ['@signet/types', '@signet/ui', '@signet/sdk', '@signet/db'],
  // Fonts are loaded via @import in globals.css — disable Next.js font optimization
  // to prevent build-time font downloads from blocking the build in offline envs.
  optimizeFonts: false,
};

module.exports = nextConfig;
