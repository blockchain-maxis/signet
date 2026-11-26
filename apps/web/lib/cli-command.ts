/**
 * Canonical CLI commands and availability copy used across the application.
 *
 * Gated npm release policy is documented in `docs/RELEASING.md`.
 */

export const CLI_LINK_COMMAND = 'npx @signet/cli link';

/** Where the CLI is documented. */
export const CLI_DOCS_URL = 'https://github.com/blockchain-maxis/signet/blob/main/docs/CLI.md';

/**
 * The one sentence every surface uses for how to get the CLI (#909). npm
 * publishing is gated (`docs/RELEASING.md`: `CLI_RELEASE_ENABLED`), so the npm
 * route is conditional on a published release, and building from source
 * (`docs/CLI.md`) is the route that always works.
 */
export const CLI_INSTALL_SENTENCE =
  'The CLI installs from npm (npx @signet/cli, or npm install -g @signet/cli) once a release is published there; npm publishing is gated, so until then build it from source as docs/CLI.md describes.';
