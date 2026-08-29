import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config. Excluded from `tsc`/`pnpm test` so the gates don't require
 * Playwright to be installed. To enable:
 *
 *   pnpm add -D @playwright/test
 *   pnpm exec playwright install --with-deps chromium
 *   pnpm --filter @signet/web test:e2e
 *
 * `webServer` boots the production build and runs the specs against it.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: `http://localhost:${PORT}`, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm --filter @signet/web start -p ${PORT}`,
    // Must be a route that really exists: `/health` is not a route, so
    // middleware treats it as a handle and it now correctly 404s, which would
    // stall the readiness probe until the timeout.
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // The opt-in testnet spec (e2e/testnet-claim.spec.ts) needs the server's
      // chain fallback pointed at the registry it claims on. These are
      // server-side vars read at request time, so no rebuild is needed — and
      // they are passed only when that spec is enabled, keeping the default
      // e2e run hermetic (no registry, no RPC traffic).
      ...(process.env.SIGNET_TESTNET_E2E
        ? {
            REGISTRY_CONTRACT_ID:
              process.env.REGISTRY_CONTRACT_ID ??
              'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
            SOROBAN_RPC_URL:
              process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
          }
        : {}),
    },
  },
});
