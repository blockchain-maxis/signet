import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isRevoked, type SessionClaims } from './session-revocation.ts';

/**
 * Session cookies minted after SEP-10 sign-in (`/api/auth/sep10`).
 *
 * Cookies are stateless HMAC-signed payloads carrying the authenticated
 * Stellar address, a random session id (`sid`), and issue/expiry timestamps.
 * Global logout runs through `SIGNET_SESSIONS_VALID_AFTER`; per-session and
 * per-address revocation go through `session-revocation.ts`.
 */

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'signet_session';

/**
 * Resolve the signing secret lazily (so a missing secret fails at request time,
 * not at build/module-load). In production a strong secret is REQUIRED — we
 * refuse to fall back to a known dev value, which would make sessions forgeable.
 */
let cachedSecret: string | null = null;
/** Exposed so other server-side signers (e.g. the SEP-10 JWT) share the same secret. */
export function getAuthSecret(): string {
  return getSecret();
}
function getSecret(): string {
  if (cachedSecret) return cachedSecret;
  const s = process.env.SIGNET_AUTH_SECRET;
  if (s && s.length >= 16) return (cachedSecret = s);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SIGNET_AUTH_SECRET must be set (≥16 chars) in production');
  }
  return (cachedSecret = 'dev-insecure-secret-change-me');
}

/**
 * Sessions issued before this epoch-ms are rejected. Bump
 * `SIGNET_SESSIONS_VALID_AFTER` to revoke every existing session at once
 * (stateless global logout) — e.g. after a secret rotation.
 *
 * This is the blunt lever, kept for the case it is right for: a leaked signing
 * secret, where every session really is suspect. Revoking one address or one
 * device goes through `session-revocation.ts` instead.
 */
function validAfter(): number {
  return Number(process.env.SIGNET_SESSIONS_VALID_AFTER ?? 0);
}

const b64url = (b: Buffer): string => b.toString('base64url');
const hmac = (data: string): Buffer => createHmac('sha256', getSecret()).update(data).digest();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ── Session ─────────────────────────────────────────────────────────────────

/**
 * Mint a session cookie for `address`.
 *
 * Every session carries a random `sid`. It costs 12 bytes in the cookie and it
 * is what makes a session addressable: without it the only thing a revocation
 * could name was the address, so "sign out my other devices" and "kill the
 * session on the laptop I lost" both collapsed into "sign out everywhere".
 */
export function issueSession(address: string): string {
  const now = Date.now();
  const sid = randomBytes(9).toString('base64url');
  const payload = JSON.stringify({ address, sid, iat: now, exp: now + SESSION_TTL_MS });
  const data = b64url(Buffer.from(payload));
  const tag = b64url(hmac(data));
  return `${data}.${tag}`;
}

/**
 * The claims of an authentic, unexpired, not-globally-revoked session — with no
 * store access at all.
 *
 * Split out from {@link verifySession} because the two questions have different
 * costs and different answers: this is pure crypto over the cookie, while the
 * targeted revocation check in `verifySession` consults a cached list. Call
 * sites that need the session id (logout revoking its own session, "sign out
 * other devices" sparing the current one) read it from here.
 *
 * `sid` is optional because sessions minted before session ids existed are
 * still within their seven-day lifetime; they verify, and any address-scoped
 * revocation covers them.
 */
export function readSession(token: string | undefined): SessionClaims | null {
  if (!token) return null;
  const [data, tag] = token.split('.');
  if (!data || !tag) return null;
  if (!safeEqual(tag, b64url(hmac(data)))) return null;
  try {
    const { address, sid, iat, exp } = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (typeof address !== 'string' || typeof exp !== 'number' || Date.now() > exp) return null;
    if (typeof iat !== 'number' || iat < validAfter()) return null; // globally revoked
    return { address, iat, exp, ...(typeof sid === 'string' ? { sid } : {}) };
  } catch {
    return null;
  }
}

/**
 * The address behind a session cookie, or `null` if the cookie is not a valid,
 * live, unrevoked session.
 *
 * Async because of the revocation check — which reads an in-memory snapshot on
 * the happy path, not the store; see `session-revocation.ts` for why that is
 * not a per-request round trip.
 */
export async function verifySession(token: string | undefined): Promise<string | null> {
  const claims = readSession(token);
  if (!claims) return null;
  return (await isRevoked(claims)) ? null : claims.address;
}
