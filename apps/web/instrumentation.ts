/**
 * Server startup hook. Next calls `register` once per server instance, before
 * the first request is served.
 *
 * This is where the production environment is checked, so a deployment missing
 * a required public variable refuses to boot instead of quietly publishing
 * `http://localhost:3000` in its sitemap, robots.txt and social cards (see
 * `lib/public-env.ts`).
 *
 * Two deliberate exclusions:
 *
 *   - the build. `next build` runs with `NODE_ENV=production` on machines with
 *     no deployment environment — CI, and any contributor running `pnpm build`.
 *     Failing there would block work that has nothing to do with deploying, so
 *     the build phase is skipped and the check lands at server start.
 *   - the edge runtime. Middleware gets its own instrumentation invocation with
 *     a different global scope; the guard only needs to run once, on the Node
 *     server that renders the pages holding the absolute URLs.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { assertPublicEnv, publicEnvWarnings, readPublicEnv } = await import('./lib/public-env.ts');
  const { logger } = await import('./lib/logger.ts');

  const env = readPublicEnv();
  for (const warning of publicEnvWarnings(env)) {
    logger.warn({ warning }, 'env.warning');
  }

  // Throwing here fails startup, which is the point: every alternative
  // publishes wrong absolute URLs and reports success while doing it.
  assertPublicEnv(env);
}
