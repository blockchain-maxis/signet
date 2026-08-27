import { NextResponse } from 'next/server';
import { WebAuth } from '@stellar/stellar-sdk';
import {
  buildChallenge,
  verifyChallenge,
  issueJwt,
  getNetworkPassphrase,
  Sep10ConfigError,
  Sep10Error,
} from '@/lib/sep10';
import { issueSession, SESSION_COOKIE } from '@/lib/auth';
import { isValidStellarAddress } from '@/lib/stellar-address';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * SEP-10 (https://stellar.org/protocol/sep-10) `WEB_AUTH_ENDPOINT`.
 *
 * The spec uses a single URL for both steps — `GET` for the challenge, `POST`
 * for verification — because that's the URL `stellar.toml` advertises and
 * what generic SEP-10 clients are built to call. Splitting these across two
 * paths would work for a client written against this app specifically, but
 * break anything using a standard SEP-10 library.
 *
 * Must be reachable cross-origin: the entire point is interoperability with
 * wallets/tooling that aren't this app's own frontend, so the usual
 * same-origin check (see `lib/security.ts`) does not apply here.
 */
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

/**
 * Stamp the CORS header onto a response built elsewhere (the shared rate-limit
 * guard). A 429 a cross-origin SEP-10 client cannot read is a 429 it cannot act
 * on — it would surface as an opaque network failure instead of "back off".
 */
function withCors(res: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.headers.set(key, value);
  return res;
}

export async function GET(req: Request) {
  // Tightest bucket in the app. This endpoint is unauthenticated, deliberately
  // reachable cross-origin, and signs a transaction on every call — without a
  // limit, any page on the web can drive ed25519 signing here.
  const limited = await enforceRateLimit(req, 'sep10:challenge', LIMITS.sep10);
  if (limited) return withCors(limited);

  const { searchParams } = new URL(req.url);
  const account = searchParams.get('account');
  const homeDomain = searchParams.get('home_domain') ?? undefined;

  if (!account || !isValidStellarAddress(account)) {
    return NextResponse.json(
      { error: 'account is required and must be a valid Stellar address' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const transaction = buildChallenge(account, homeDomain);
    return NextResponse.json(
      { transaction, network_passphrase: getNetworkPassphrase() },
      { headers: { ...CORS_HEADERS, 'cache-control': 'no-store' } },
    );
  } catch (err) {
    // A missing or malformed signing key is our fault, not the caller's — a 400
    // told SEP-10 clients to fix their request when nothing about it was wrong.
    if (err instanceof Sep10ConfigError) {
      logger.error({ err: err.message }, 'sep10.misconfigured');
      return NextResponse.json({ error: err.message }, { status: 503, headers: CORS_HEADERS });
    }
    const message = err instanceof Sep10Error ? err.message : 'Could not build challenge';
    return NextResponse.json({ error: message }, { status: 400, headers: CORS_HEADERS });
  }
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'sep10:verify', LIMITS.sep10);
  if (limited) return withCors(limited);

  const { transaction } = (await req.json().catch(() => ({}))) as { transaction?: string };
  if (!transaction) {
    return NextResponse.json({ error: 'transaction is required' }, { status: 400, headers: CORS_HEADERS });
  }

  let clientAccountId: string;
  try {
    clientAccountId = verifyChallenge(transaction);
  } catch (err) {
    if (err instanceof Sep10ConfigError) {
      logger.error({ err: err.message }, 'sep10.misconfigured');
      return NextResponse.json({ error: err.message }, { status: 503, headers: CORS_HEADERS });
    }
    const message =
      err instanceof Sep10Error || err instanceof WebAuth.InvalidChallengeError
        ? err.message
        : 'Invalid challenge transaction';
    logger.warn({ error: message }, 'sep10.verifyRejected');
    return NextResponse.json({ error: message }, { status: 401, headers: CORS_HEADERS });
  }

  const res = NextResponse.json({ token: issueJwt(clientAccountId) }, { headers: CORS_HEADERS });
  // Same-origin convenience: lets this app's own frontend use the normal
  // cookie session immediately, alongside the spec-mandated bearer token.
  // SameSite=lax means genuine cross-origin callers never get this sent back.
  res.cookies.set(SESSION_COOKIE, issueSession(clientAccountId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  logger.info({ address: clientAccountId }, 'sep10.signedIn');
  return res;
}

export function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      ...CORS_HEADERS,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
