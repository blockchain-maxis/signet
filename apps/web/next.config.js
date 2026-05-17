/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source, so Next must
  // transpile them.
  transpilePackages: ['@signet/types', '@signet/ui', '@signet/sdk', '@signet/db'],
};

module.exports = nextConfig;
