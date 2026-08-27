/**
 * Same-origin guard for state-changing (POST) requests — CSRF defense for the
 * cookie-based session. We compare the request's Origin/Referer host against
 * the app's own host(s). A state-changing request with no Origin/Referer is
 * rejected (browsers always send one on cross-site form/fetch POSTs).
 */
export function isSameOrigin(req: Request): boolean {
  return isSameOriginHeaders(req.headers);
}

/**
 * The caller's IP, for rate-limit bucketing.
 *
 * Every forwarding header is, by default, a string the client chose. The old
 * implementation read the leftmost `X-Forwarded-For` entry, which is precisely
 * the attacker-controlled one: rotating that header minted a fresh bucket per
 * request and the limiter never fired.
 *
 * Only two kinds of header are safe to believe:
 *
 *   1. **Platform headers the edge overwrites.** Vercel sets
 *      `x-vercel-forwarded-for` and Netlify sets `x-nf-client-connection-ip`
 *      from the real connection, replacing whatever the client sent. These are
 *      detected automatically, so the deployed app needs no configuration.
 *   2. **`X-Forwarded-For`, but only behind a proxy you have told us about.**
 *      A proxy *appends* the peer address, so with `n` trusted hops in front,
 *      the nth entry from the right is the last one the client could not
 *      choose. Set `SIGNET_TRUSTED_PROXY_HOPS` to that number.
 *
 * Absent both, every caller shares one bucket rather than getting a free one
 * each. That direction is deliberate: over-throttling a shared bucket is a
 * visible, recoverable annoyance, whereas silently disabling the limiter is a
 * vulnerability that looks exactly like working code.
 */
export const UNKNOWN_IP = 'unknown';

function trustedHops(): number {
  const raw = Number(process.env.SIGNET_TRUSTED_PROXY_HOPS ?? 0);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

export function clientIp(headers: Headers): string {
  const platform =
    headers.get('x-vercel-forwarded-for') ?? headers.get('x-nf-client-connection-ip');
  if (platform?.trim()) return platform.trim();

  const hops = trustedHops();
  if (hops === 0) return UNKNOWN_IP;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const chain = forwarded
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    // With `hops` trusted proxies in front, they appended the last `hops`
    // entries; the first of those is the peer address the outermost proxy saw.
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate;
  }

  // A single trusted hop also covers the conventional reverse-proxy header.
  const realIp = headers.get('x-real-ip');
  if (realIp?.trim()) return realIp.trim();

  return UNKNOWN_IP;
}

/** Header-level same-origin check — usable wherever there's no full `Request`. */
export function isSameOriginHeaders(headers: Headers): boolean {
  const allowed = new Set<string>();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) {
    try {
      allowed.add(new URL(appUrl).host);
    } catch {
      /* ignore malformed env */
    }
  }
  const host = headers.get('host');
  if (host) allowed.add(host);

  const source = headers.get('origin') ?? headers.get('referer');
  if (!source) return false;
  try {
    return allowed.has(new URL(source).host);
  } catch {
    return false;
  }
}
