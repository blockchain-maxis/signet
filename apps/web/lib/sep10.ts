import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Keypair, Networks, WebAuth } from '@stellar/stellar-sdk';
import { getAuthSecret } from './auth.ts';

/**
 * SEP-10 (https://stellar.org/protocol/sep-10) Stellar Web Authentication.
 *
 * This runs alongside the pre-existing custom Sign-In-With-Stellar flow
 * (`auth.ts` / `/api/auth/{challenge,verify}`), which is left untouched so
 * existing clients keep working. SEP-10 is exposed on its own endpoints
 * (`/api/auth/sep10/{challenge,verify}`) and, on success, mints the same
 * session cookie `auth.ts` issues — so the rest of the app (tRPC's
 * `account.*`, `getSession()`) doesn't need to know which flow a caller used.
 *
 * The challenge/verify mechanics (timebounds, the `home_domain` /
 * `web_auth_domain` Manage Data operations, signature checks) are delegated
 * to `@stellar/stellar-sdk`'s `WebAuth` module, which implements the spec
 * directly — hand-rolling this is exactly where subtle spec violations creep
 * in (transposed domain fields, infinite timebounds, etc).
 *
 * Signer support: this only verifies the client account's master key
 * (single-signature accounts). Multisig accounts would need a Horizon lookup
 * of the account's signers/thresholds (`WebAuth.verifyChallengeTxThreshold`)
 * — out of scope for now, and uncommon for the wallets this app targets.
 */

const CHALLENGE_TIMEOUT_SECONDS = 5 * 60;
const JWT_TTL_SECONDS = 5 * 60;

function isMainnet(): boolean {
  const network = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet').toLowerCase();
  return network === 'mainnet' || network === 'public';
}

export function getNetworkPassphrase(): string {
  return isMainnet() ? Networks.PUBLIC : Networks.TESTNET;
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
  if (secret) return (cachedKeypair = Keypair.fromSecret(secret));
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SEP10_SIGNING_SECRET must be set in production');
  }
  return (cachedKeypair = Keypair.random());
}

export class Sep10Error extends Error {}

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
