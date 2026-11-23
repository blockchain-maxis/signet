/**
 * Canonical CLI commands and availability copy used across the application.
 *
 * Gated npm release policy is documented in `docs/RELEASING.md`.
 */

export const CLI_LINK_COMMAND = 'npx @signet/cli link';
export const CLI_INSTALL_COMMAND = 'npm install -g @signet/cli';

/** Where the CLI is documented. */
export const CLI_DOCS_URL = 'https://github.com/blockchain-maxis/signet/blob/main/docs/CLI.md';

/**
 * Single canonical sentence describing how to get and run the CLI.
 * Aligns with docs/RELEASING.md policy on gated npm publishing.
 */
export const CLI_INSTALL_SENTENCE =
  'Run directly with npx @signet/cli, install globally with npm install -g @signet/cli, or build from source (see docs/CLI.md) until npm releases are published.';
