/**
 * CORS + Private Network Access policy for the CLI's loopback callback server.
 *
 * The approval page is served over HTTPS from the deployment; the callback
 * target is `http://127.0.0.1:<port>`. Loopback is a potentially-trustworthy
 * origin, so mixed-content blocking does not apply — but Chrome sends a
 * **CORS preflight for public → private requests** and requires the private
 * server to opt in explicitly. Without that opt-in the callback fails in
 * Chrome with an opaque network error and the CLI simply waits out its
 * timeout. It works fine in local testing, because localhost → localhost is
 * not a public → private transition, which is what makes this the most likely
 * way the feature breaks for a developer and the least likely way it breaks
 * for whoever wrote it.
 *
 * Kept as pure functions over plain header maps, with no server or transport
 * in sight, so the policy is testable on its own and portable if the CLI is
 * re-hosted (the Go module in #251, say) — the headers are protocol, not
 * implementation.
 *
 * References: WHATWG Fetch (CORS preflight), W3C Private Network Access.
 */

/** The header Chrome sends on a public → private preflight. */
export const PNA_REQUEST_HEADER = 'access-control-request-private-network';

/** The opt-in the private server must answer with. */
export const PNA_RESPONSE_HEADER = 'access-control-allow-private-network';

/** Methods the callback endpoint accepts. */
export const ALLOWED_METHODS = 'POST, OPTIONS';

/** Request headers the approval page is allowed to send. */
export const ALLOWED_HEADERS = 'content-type';

/**
 * How long a browser may cache the preflight. Short on purpose: the server
 * lives for one pairing and then exits, so a long-lived cached preflight for
 * `127.0.0.1:<port>` would outlive it and apply to whatever binds that port
 * next.
 */
export const MAX_AGE_SECONDS = 60;

export type HeaderMap = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderMap, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Exact-match origin check.
 *
 * Scoped to the deployment origin **only** — never `*`. A wildcard on a
 * loopback server that is about to accept a pairing completion means any page
 * the developer has open can post to it. Comparison is on the parsed origin
 * rather than the raw string, so `https://signet.dev` and
 * `https://signet.dev:443` compare equal and `https://signet.dev.evil.test`
 * does not.
 */
export function isAllowedOrigin(origin: string | undefined, deploymentOrigin: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(deploymentOrigin).origin;
  } catch {
    return false;
  }
}

export interface PreflightDecision {
  /** HTTP status to answer the OPTIONS request with. */
  status: number;
  headers: Record<string, string>;
  /**
   * Set when the request was refused, for the CLI to print. A developer whose
   * callback is being rejected deserves to know which origin was asking.
   */
  refusal?: string;
}

/**
 * Answer a preflight (`OPTIONS`) request.
 *
 * A disallowed origin gets **403 with no CORS headers at all**, rather than a
 * 204 with headers omitted: the browser rejects both, but the first leaves a
 * visible refusal in the network tab and the server log instead of a silent
 * "CORS error" the developer has to guess at.
 */
export function handlePreflight(
  requestHeaders: HeaderMap,
  deploymentOrigin: string,
): PreflightDecision {
  const origin = headerValue(requestHeaders, 'origin');

  if (!isAllowedOrigin(origin, deploymentOrigin)) {
    return {
      status: 403,
      headers: {},
      refusal: `refused preflight from origin ${origin ?? '<none>'}; expected ${deploymentOrigin}`,
    };
  }

  const headers: Record<string, string> = {
    // Echo the exact origin. Never "*": this server is about to accept a
    // pairing completion, and a wildcard means any open tab can post to it.
    'access-control-allow-origin': origin as string,
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-max-age': String(MAX_AGE_SECONDS),
    // Caches must not serve one origin's preflight answer to another.
    vary: 'Origin, Access-Control-Request-Private-Network',
  };

  // The PNA opt-in is sent **only** when the browser asked for it. Sending it
  // unconditionally would advertise private-network access to every caller,
  // including ones that never needed it.
  if (headerValue(requestHeaders, PNA_REQUEST_HEADER) === 'true') {
    headers[PNA_RESPONSE_HEADER] = 'true';
  }

  return { status: 204, headers };
}

/**
 * Headers for the actual (non-preflight) `POST` response.
 *
 * The preflight passing does not exempt the real response: without
 * `Access-Control-Allow-Origin` here too, the browser blocks reading the
 * result and the page cannot tell success from failure — which is exactly the
 * silent hang this issue is about.
 */
export function responseHeaders(
  requestHeaders: HeaderMap,
  deploymentOrigin: string,
): Record<string, string> {
  const origin = headerValue(requestHeaders, 'origin');
  if (!isAllowedOrigin(origin, deploymentOrigin)) return {};
  return {
    'access-control-allow-origin': origin as string,
    vary: 'Origin',
  };
}
