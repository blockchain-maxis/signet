import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sign-In With Stellar (server side).
 *
 * Flow: issue a server-tagged challenge → the wallet signs it (proving key
 * ownership) → we verify both the challenge tag (it's ours, and fresh) and the
 * ed25519 signature, then mint an HMAC-signed session cookie.
 *
 * Stateless on purpose: the challenge carries its own HMAC tag + timestamp, so
 * no server-side nonce store is needed. For very high security, swap to a
 * single-use stored nonce — the call sites won't change.
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

export function verifyChallenge(address: string, message: string): boolean {
  const fields = Object.fromEntries(
    message
      .split('\n')
      .map((l) => l.split(': '))
      .filter((p) => p.length === 2) as [string, string][],
  );
  const { Nonce: nonce, Issued: issued, Tag: tag } = fields;
  if (fields.Address !== address || !nonce || !issued || !tag) return false;
  if (Date.now() - Number(issued) > CHALLENGE_TTL_MS) return false;
  const expected = b64url(hmac(`${address}|${issued}|${nonce}`));
  return safeEqual(tag, expected);
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

export function issueSession(address: string): string {
  const now = Date.now();
  const payload = JSON.stringify({ address, iat: now, exp: now + SESSION_TTL_MS });
  const data = b64url(Buffer.from(payload));
  const tag = b64url(hmac(data));
  return `${data}.${tag}`;
}

export function verifySession(token: string | undefined): string | null {
  if (!token) return null;
  const [data, tag] = token.split('.');
  if (!data || !tag) return null;
  if (!safeEqual(tag, b64url(hmac(data)))) return null;
  try {
    const { address, iat, exp } = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (typeof address !== 'string' || typeof exp !== 'number' || Date.now() > exp) return null;
    if (typeof iat !== 'number' || iat < validAfter()) return null; // revoked
    return address;
  } catch {
    return null;
  }
}
