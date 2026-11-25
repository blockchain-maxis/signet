import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import { normalizeNetwork, networkPassphrase } from '@signet/types';
import { getAuthSecret } from './auth.ts';
import { spendChallenge } from './server/challenge-spend.ts';
import { issueSession, SESSION_COOKIE } from './auth.ts';
import { logger } from './logger.ts';

const CHALLENGE_TIMEOUT_SECONDS = 5 * 60;
const JWT_TTL_SECONDS = 5 * 60;

export function getNetworkPassphrase(): string {
  const raw = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet';
  return networkPassphrase(normalizeNetwork(raw));
}

/** The service's home domain — also doubles as the web auth domain (single-domain deployment). */
export function getHomeDomain(): string {
  return process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'signet.dev';
}

export function getWebAuthDomain(): string {
  return process.env.SEP10_WEB_AUTH_DOMAIN ?? getHomeDomain();
}

/**
 * The server's Stellar signing account for SEP-10 challenges. In production
 * this MUST be set — an ephemeral dev keypair would make `stellar.toml`'s
 * advertised `SIGNING_KEY` wrong on every restart, and (like `auth.ts`'s HMAC
 * secret) we refuse to silently run production on a throwaway key.
 */
let cachedKeypair: Keypair | null = null;
export function getServerKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;
  const secret = process.env.SEP10_SIGNING_SECRET;
  if (secret) {
    try {
      return (cachedKeypair = Keypair.fromSecret(secret));
    } catch {
      // `Keypair.fromSecret` throws a bare `invalid checksum` with no hint at
      // which setting is wrong. Left unhandled it surfaced as an anonymous 500
      // from `/.well-known/stellar.toml` — the discovery document every SEP-10
      // client reads first — so a one-character typo looked like an outage.
      throw new Sep10ConfigError(
        'SEP10_SIGNING_SECRET is not a valid Stellar secret key (expected an S… StrKey)',
      );
    }
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Sep10ConfigError('SEP10_SIGNING_SECRET must be set in production');
  }
  return (cachedKeypair = Keypair.random());
}

export class Sep10Error extends Error {}

/**
 * The service is misconfigured — distinct from `Sep10Error`, which means the
 * *caller* sent something invalid. Routes map this to a 503: nothing the client
 * did caused it, and no retry with different input will fix it.
 */
export class Sep10ConfigError extends Error {}

/**
 * Build a SEP-10 challenge transaction for `clientAccountId`.
 *
 * `homeDomain`, when supplied by the caller (the `home_domain` query param),
 * must match this service's configured domain — accepting an arbitrary
 * caller-supplied value would let a client mint a challenge for a domain it
 * doesn't own, defeating the replay protection `home_domain` is for.
 */
export function buildChallenge(clientAccountId: string, homeDomain?: string): string {
  const expectedHomeDomain = getHomeDomain();
  if (homeDomain && homeDomain !== expectedHomeDomain) {
    throw new Sep10Error(`home_domain must be ${expectedHomeDomain}`);
  }
  return WebAuth.buildChallengeTx(
    getServerKeypair(),
    clientAccountId,
    expectedHomeDomain,
    CHALLENGE_TIMEOUT_SECONDS,
    getNetworkPassphrase(),
    getWebAuthDomain(),
  );
}

/**
 * Verify a signed SEP-10 challenge transaction and return the authenticated
 * client account id. Throws `Sep10Error` (or a `WebAuth.InvalidChallengeError`
 * from the SDK) on any failure: bad server signature, wrong domains, expired
 * or infinite timebounds, missing/invalid client signature.
 */
export function verifyChallenge(transactionXdr: string): string {
  const serverAccountId = getServerKeypair().publicKey();
  const { clientAccountID } = WebAuth.readChallengeTx(
    transactionXdr,
    serverAccountId,
    getNetworkPassphrase(),
    getHomeDomain(),
    getWebAuthDomain(),
  );
  const signers = WebAuth.verifyChallengeTxSigners(
    transactionXdr,
    serverAccountId,
    getNetworkPassphrase(),
    [clientAccountID],
    getHomeDomain(),
    getWebAuthDomain(),
  );
  if (!signers.includes(clientAccountID)) {
    throw new Sep10Error('Challenge was not signed by the client account');
  }
  return clientAccountID;
}

/**
 * Compute the transaction hash from a SEP-10 challenge XDR.
 * Used as the dedup key for replay protection so that re-encoding
 * the same signed transaction cannot produce a new key.
 */
export function challengeHash(transactionXdr: string): string {
  const tx = TransactionBuilder.fromXDR(transactionXdr, getNetworkPassphrase());
  return tx.hash().toString('hex');
}

/**
 * Verify a signed SEP-10 challenge, spend it (single-use), and mint
 * the JWT + session cookie. This is the single entry point for the
 * sign-in flow so the verify → spend → mint ordering is enforced.
 *
 * Returns the client account ID on success, or throws:
 * - Sep10ConfigError (503): server misconfiguration
 * - Sep10Error (401): invalid challenge (bad signature, wrong domain, expired, replayed)
 * - Error (503): nonce store unavailable (fails closed)
 */
export async function authenticateWithSep10(transactionXdr: string): Promise<string> {
  let clientAccountId: string;
  try {
    clientAccountId = verifyChallenge(transactionXdr);
  } catch (err) {
    if (err instanceof Sep10ConfigError) {
      logger.error({ err: err.message }, 'sep10.misconfigured');
      throw err;
    }
    const message =
      err instanceof Sep10Error || err instanceof WebAuth.InvalidChallengeError
        ? err.message
        : 'Invalid challenge transaction';
    logger.warn({ error: message }, 'sep10.verifyRejected');
    throw new Sep10Error(message);
  }

  // Spend the challenge *after* verification but *before* minting.
  // A bad signature never burns a valid challenge; a replay is rejected
  // before any JWT or cookie is issued.
  const spent = await spendChallenge(transactionXdr);
  if (!spent) {
    logger.warn({ hash: challengeHash(transactionXdr) }, 'sep10.replayed');
    throw new Sep10Error('Challenge has already been used');
  }

  return clientAccountId;
}

/**
 * Mint the JWT and session cookie for a verified client account.
 * Separated so callers that only need the token (e.g. CLI pairing)
 * can skip the cookie.
 */
export function mintSep10Session(clientAccountId: string): {
  token: string;
  cookie: { name: string; value: string; options: { httpOnly: boolean; secure: boolean; sameSite: 'lax'; path: string; maxAge: number } };
} {
  const token = issueJwt(clientAccountId);
  const cookieValue = issueSession(clientAccountId);
  return {
    token,
    cookie: {
      name: SESSION_COOKIE,
      value: cookieValue,
      options: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      },
    },
  };
}

// ── JWT (the spec's response token) ─────────────────────────────────────────

const b64url = (input: Buffer | string): string =>
  Buffer.from(input as string).toString('base64url').replace(/=+$/, '');

function sign(data: string): string {
  return createHmac('sha256', getAuthSecret()).update(data).digest('base64url');
}

/** Mint a standard HS256 JWT for a verified client account (the spec's `token`). */
export function issueJwt(clientAccountId: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iss: getWebAuthDomain(),
      sub: clientAccountId,
      iat: now,
      exp: now + JWT_TTL_SECONDS,
      jti: randomUUID(),
    }),
  );
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string): string | null {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof sub !== 'string' || typeof exp !== 'number' || Date.now() / 1000 > exp) return null;
    return sub;
  } catch {
    return null;
  }
}

export { Sep10Error, Sep10ConfigError };