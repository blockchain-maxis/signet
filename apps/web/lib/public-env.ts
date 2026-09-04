/**
 * Fail-fast guard for the public environment variables a production deployment
 * cannot work without.
 *
 * `NEXT_PUBLIC_APP_URL` had a `http://localhost:3000` default that was used
 * unguarded on paths that publish absolute URLs to the outside world — the
 * sitemap, `robots.txt`, `metadataBase` behind every social card, the SEP-1
 * `WEB_AUTH_ENDPOINT`, and the server-side tRPC base. Forget the variable and
 * every one of those silently addresses localhost: the build succeeds, the
 * pages render, and the only party that notices is a search engine or a wallet
 * that cannot reach the auth endpoint it was handed.
 *
 * So the localhost default stays a *development* convenience, and production
 * refuses to boot without a real value — the same shape as the network/RPC
 * mismatch guard in `network-guard.ts` and the `SIGNET_AUTH_SECRET` check in
 * `auth.ts`: name the variable, say what would break, stop.
 *
 * Where the guard runs: `instrumentation.ts`, once per server start. Not at
 * module load — a module-scope throw would take out `next build`, which runs
 * with `NODE_ENV=production` and legitimately has no deployment environment.
 *
 * `NEXT_PUBLIC_*` values are inlined into the client bundle at build time, so
 * every read here is a literal `process.env.NEXT_PUBLIC_APP_URL` property
 * access. Reading it through a computed key would work on the server and
 * quietly yield `undefined` in the browser.
 *
 * The same build-time-ness is why `app/robots.ts` and `app/sitemap.ts` are
 * `force-dynamic`: prerendered, they bake whatever the *build* environment
 * had, so a deployment with a perfectly correct runtime environment could
 * still serve a sitemap of localhost URLs — and the startup guard, which reads
 * the runtime environment, would have passed. Rendering them on demand makes
 * the value this guard checked the value that gets published.
 */

/** The development-only default. Never correct for a deployed site. */
export const LOCALHOST_APP_URL = 'http://localhost:3000';

/** Just the variables this guard reads, so callers can pass a fixture. */
export interface PublicEnv {
  NEXT_PUBLIC_APP_URL?: string | undefined;
  NODE_ENV?: string | undefined;
}

interface RequiredVar {
  name: string;
  /**
   * Literal read of this variable off the environment. A function rather than
   * an index, because Next inlines `NEXT_PUBLIC_*` by textual substitution and
   * a computed lookup would come back undefined in the browser bundle.
   */
  read: (env: PublicEnv) => string | undefined;
  /** What silently breaks when it is missing, for the error message. */
  breaks: string;
}

/**
 * Public variables a production deployment must set explicitly. Kept as a list
 * so the next one that grows a wrong-but-plausible default joins it here rather
 * than growing its own bespoke check.
 */
const REQUIRED_IN_PRODUCTION: RequiredVar[] = [
  {
    name: 'NEXT_PUBLIC_APP_URL',
    read: (env) => env.NEXT_PUBLIC_APP_URL,
    breaks:
      'the sitemap, robots.txt, Open Graph metadataBase and the SEP-1 WEB_AUTH_ENDPOINT ' +
      `would all publish ${LOCALHOST_APP_URL} URLs`,
  },
];

/** True when the app is running as a production build. */
export function isProduction(env: PublicEnv): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Normalize a configured site origin: trims, requires an absolute `http(s)`
 * URL, and drops any trailing slash so `${APP_URL}/path` never doubles it.
 * Returns null when the value is absent or unusable as a base URL.
 */
export function normalizeAppUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.search || parsed.hash) return null;
  return parsed.href.replace(/\/+$/, '');
}

/** Loopback hosts — fine locally and for e2e, wrong for anything published. */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Returns a human-readable description of the misconfiguration, or `null` when
 * the environment is usable. A malformed value is an error everywhere; a
 * *missing* one is an error only in production, where the localhost default
 * would be published rather than merely used locally.
 */
export function checkPublicEnv(env: PublicEnv): string | null {
  const production = isProduction(env);
  const problems: string[] = [];

  for (const { name, read, breaks } of REQUIRED_IN_PRODUCTION) {
    const value = read(env)?.trim();

    if (!value) {
      if (production) problems.push(`${name} is not set — ${breaks}`);
      continue;
    }
    if (!normalizeAppUrl(value)) {
      problems.push(
        `${name} ("${value}") is not an absolute http(s) URL without a query or fragment`,
      );
    }
  }

  if (problems.length === 0) return null;

  return (
    'Missing or invalid public environment: ' +
    problems.join('; ') +
    '. Set the required variables for this deployment; the ' +
    `${LOCALHOST_APP_URL} default is for local development only.`
  );
}

/**
 * Non-fatal observations. A loopback origin explicitly configured in
 * production is how the e2e suite boots `next start`, so it must not refuse to
 * start — but on a real deployment it is a mistake worth saying out loud.
 */
export function publicEnvWarnings(env: PublicEnv): string[] {
  const url = normalizeAppUrl(env.NEXT_PUBLIC_APP_URL);
  if (!isProduction(env) || !url || !isLoopback(url)) return [];
  return [
    `NEXT_PUBLIC_APP_URL is set to a loopback address (${url}) in a production build. ` +
      'Absolute URLs in the sitemap, robots.txt and social cards will point at this machine.',
  ];
}

/** Throws when a required public variable is missing or unusable. */
export function assertPublicEnv(env: PublicEnv = readPublicEnv()): void {
  const message = checkPublicEnv(env);
  if (message) throw new Error(message);
}

/** Snapshot of the variables this module reads, via literal property access. */
export function readPublicEnv(): PublicEnv {
  return {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
}

/**
 * The site's public origin, without a trailing slash.
 *
 * In production this is always the configured value: the startup guard refuses
 * to boot without one, so the localhost fallback below is unreachable in a
 * running production server. It remains for development, for tests, and for
 * `next build`, none of which have (or need) a deployment environment.
 */
export function appUrl(): string {
  return normalizeAppUrl(process.env.NEXT_PUBLIC_APP_URL) ?? LOCALHOST_APP_URL;
}
