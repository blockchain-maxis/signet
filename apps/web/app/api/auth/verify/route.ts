import { NextResponse } from 'next/server';
import {
  redeemChallenge,
  issueSession,
  SESSION_COOKIE,
  type ChallengeOutcome,
} from '@/lib/auth';
import { isValidStellarAddress } from '@/lib/stellar-address';
import { isSameOrigin } from '@/lib/security';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * All four failures are 401s. The distinct messages are for the operator and
 * for a legitimate client deciding whether to restart the flow — "already used"
 * means fetch a new challenge, "bad signature" means the wallet signed wrong.
 */
const CHALLENGE_ERRORS: Record<Exclude<ChallengeOutcome, 'ok'>, string> = {
  'invalid-challenge': 'Challenge invalid or expired',
  'bad-signature': 'Bad signature',
  replayed: 'Challenge has already been used',
};

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  // Ahead of the signature check: verification is the expensive part.
  const limited = await enforceRateLimit(req, 'auth:verify', LIMITS.authVerify);
  if (limited) return limited;
  const { address, message, signature } = (await req.json().catch(() => ({}))) as {
    address?: string;
    message?: string;
    signature?: string;
  };

  if (!address || !message || !signature || !isValidStellarAddress(address)) {
    return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 });
  }
  const outcome = await redeemChallenge(address, message, signature);
  if (outcome !== 'ok') {
    logger.warn({ address, outcome }, 'auth.challengeRejected');
    return NextResponse.json({ error: CHALLENGE_ERRORS[outcome] }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, address });
  res.cookies.set(SESSION_COOKIE, issueSession(address), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  logger.info({ address }, 'auth.signedIn');
  return res;
}
