import { NextResponse } from 'next/server';
import { WebAuth } from '@stellar/stellar-sdk';
import {
  buildCliLinkChallenge,
  verifyCliLinkChallenge,
  getConfiguredNetwork,
  CliLinkError,
  CliLinkConfigError,
} from '@/lib/cli-link';
import { getNetworkPassphrase, Sep10Error } from '@/lib/sep10';
import { isValidStellarAddress } from '@/lib/stellar-address';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * `signet link`'s challenge/verify endpoint — the CLI's own SEP-10-shaped
 * exchange, kept on a separate path from `/api/auth/sep10` (web sign-in) so
 * the two purposes never share a challenge shape. See `lib/cli-link.ts`.
 *
 * This verifies that the caller controls the deploy wallet's private key and
 * that its declared network matches this deployment's configured one. It
 * does *not* attach the wallet to a profile: doing that safely requires
 * proving the CALLER is also authorized to modify the target handle's
 * profile (proof of possessing a deploy key alone isn't authorization to
 * attach it to someone else's handle) — a separate mechanism this endpoint
 * intentionally leaves for a follow-up rather than shipping a half-built
 * authorization check.
 */
const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

function withCors(res: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.headers.set(key, value);
  return res;
}

export async function GET(req: Request) {
  // Same reasoning as sep10: unauthenticated, cross-origin (a CLI has no
  // browser origin at all), and signs a transaction on every call.
  const limited = await enforceRateLimit(req, 'cli-link:challenge', LIMITS.cliLink);
  if (limited) return withCors(limited);

  const { searchParams } = new URL(req.url);
  const account = searchParams.get('account');
  const network = searchParams.get('network');

  if (!account || !isValidStellarAddress(account)) {
    return NextResponse.json(
      { error: 'account is required and must be a valid Stellar address' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
  if (!network) {
    return NextResponse.json(
      { error: 'network is required (e.g. "testnet" or "mainnet")' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  try {
    const transaction = buildCliLinkChallenge(account, network);
    return NextResponse.json(
      { transaction, network_passphrase: getNetworkPassphrase() },
      { headers: { ...CORS_HEADERS, 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (err instanceof CliLinkConfigError) {
      logger.error({ err: err.message }, 'cliLink.misconfigured');
      return NextResponse.json({ error: err.message }, { status: 503, headers: CORS_HEADERS });
    }
    if (err instanceof CliLinkError) {
      // A network mismatch names both networks — the caller needs both to
      // fix a --network flag or point at the right deployment.
      logger.warn(
        { requested: network, configured: getConfiguredNetwork(), error: err.message },
        'cliLink.networkMismatch',
      );
      return NextResponse.json({ error: err.message }, { status: 400, headers: CORS_HEADERS });
    }
    return NextResponse.json(
      { error: 'Could not build challenge' },
      { status: 400, headers: CORS_HEADERS },
    );
  }
}

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'cli-link:verify', LIMITS.cliLink);
  if (limited) return withCors(limited);

  const { transaction } = (await req.json().catch(() => ({}))) as { transaction?: string };
  if (!transaction) {
    return NextResponse.json(
      { error: 'transaction is required' },
      { status: 400, headers: CORS_HEADERS },
    );
  }

  let clientAccountId: string;
  try {
    clientAccountId = verifyCliLinkChallenge(transaction);
  } catch (err) {
    if (err instanceof CliLinkConfigError) {
      logger.error({ err: err.message }, 'cliLink.misconfigured');
      return NextResponse.json({ error: err.message }, { status: 503, headers: CORS_HEADERS });
    }
    const message =
      err instanceof Sep10Error || err instanceof WebAuth.InvalidChallengeError
        ? err.message
        : 'Invalid challenge transaction';
    logger.warn({ error: message }, 'cliLink.verifyRejected');
    return NextResponse.json({ error: message }, { status: 401, headers: CORS_HEADERS });
  }

  logger.info({ address: clientAccountId }, 'cliLink.verified');
  return NextResponse.json(
    { verified: true, publicKey: clientAccountId },
    { headers: CORS_HEADERS },
  );
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
