import { defineConfig, devices } from '@playwright/test';

/**
 * The local UI in a real browser (#586): the built bundle, served with
 * recorded API answers by e2e/harness.mjs. Build first:
 *
 *   pnpm --filter @signet/sandbox-ui build
 *   pnpm --filter @signet/sandbox-ui test:e2e
 */
const PORT = Number(process.env.E2E_PORT ?? 4317);

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
    // A machine without Playwright's own Chromium can run the installed Chrome.
    ...(process.env.PW_CHANNEL && { channel: process.env.PW_CHANNEL }),
  },
  projects: [
    { name: 'dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' } },
    // The server's protections do not depend on the theme: checked once.
    { name: 'light', use: { ...devices['Desktop Chrome'], colorScheme: 'light' }, testIgnore: /security\.spec/ },
  ],
  webServer: {
    command: `node e2e/harness.mjs`,
    url: `http://127.0.0.1:${PORT}/api/session`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
