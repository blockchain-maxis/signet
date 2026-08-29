import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { consumeNonce } from './nonce-store.ts';
import { isRevoked, type SessionClaims } from './session-revocation.ts';

/**
 * Sign-In With Stellar (server side).
 *
 * Flow: issue a server-tagged challenge → the wallet signs it (proving key
 * ownership) → we verify the challenge tag (it's ours, fresh, and unused) and
 * the ed25519 signature, then mint an HMAC-signed session cookie.
 *
 * The challenge carries its own HMAC tag and timestamp, so no issuance state is
 * kept. Redemption state is: each nonce is recorded once through
 * `nonce-store.ts`, which is what makes a signed challenge single-use rather
 * than replayable for its whole TTL.
 */

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

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

// ── Challenge ───────────────────────────────────────────────────────────────

export function createChallenge(address: string): string {
  const nonce = randomBytes(16).toString('hex');
  const issued = Date.now();
  const tag = b64url(hmac(`${address}|${issued}|${nonce}`));
  return [
    'Signet sign-in',
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${issued}`,
    `Tag: ${tag}`,
  ].join('\n');
}

/** The nonce carried by a challenge, if it is one we issued and it is fresh. */
function challengeNonce(address: string, message: string): string | null {
  const fields = Object.fromEntries(
    message
      .split('\n')
      .map((l) => l.split(': '))
      .filter((p) => p.length === 2) as [string, string][],
  );
  const { Nonce: nonce, Issued: issued, Tag: tag } = fields;
  if (fields.Address !== address || !nonce || !issued || !tag) return null;
  if (Date.now() - Number(issued) > CHALLENGE_TTL_MS) return null;
  const expected = b64url(hmac(`${address}|${issued}|${nonce}`));
  return safeEqual(tag, expected) ? nonce : null;
}

/** Whether `message` is a challenge we issued to `address` and is still fresh. */
export function verifyChallenge(address: string, message: string): boolean {
  return challengeNonce(address, message) !== null;
}

export type ChallengeOutcome = 'ok' | 'invalid-challenge' | 'bad-signature' | 'replayed';

/**
 * Verify a signed challenge and spend it, so it cannot be presented twice.
 *
 * The HMAC tag proves we issued the challenge and the timestamp proves it is
 * fresh, but neither says anything about how many times it has been presented.
 * Without spending it, the same message and signature minted a new session on
 * every submission until the TTL lapsed — one observed signature was a
 * five-minute session-takeover window.
 *
 * **Order matters.** The nonce is spent only after the signature verifies:
 *
 *   - Spending it earlier protects nothing. A replayer holds a *valid*
 *     signature by definition, so it would clear the signature check anyway.
 *   - Spending it earlier creates a denial of service. The challenge is handed
 *     to the client in the clear, so anyone who can see one — a script on the
 *     page, a shared log — could burn it with a junk signature and lock the
 *     real owner out of the sign-in they had already started.
 *
 * Spending last gives replay protection with neither drawback: the first
 * correctly-signed presentation wins, and every later one finds the nonce
 * spent. `consumeNonce` is atomic, so concurrent submissions cannot both win.
 *
 * Combined into one function on purpose — a call site that verified the
 * signature but forgot to spend the nonce would silently restore the
 * vulnerability.
 */
export async function redeemChallenge(
  address: string,
  message: string,
  signature: string,
): Promise<ChallengeOutcome> {
  const nonce = challengeNonce(address, message);
  if (!nonce) return 'invalid-challenge';
  if (!(await verifySignature(address, message, signature))) return 'bad-signature';
  if (!(await consumeNonce(`${address}:${nonce}`, CHALLENGE_TTL_MS))) return 'replayed';
  return 'ok';
}

/** Verify an ed25519 signature over `message` by `address` (G…). */
export async function verifySignature(
  address: string,
  message: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const { Keypair } = await import('@stellar/stellar-sdk');
    const kp = Keypair.fromPublicKey(address);
    return kp.verify(Buffer.from(message, 'utf8'), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
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
