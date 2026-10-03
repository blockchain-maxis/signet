import { NextResponse } from 'next/server';
import type { ErrorBody, UnlinkRequest, UnlinkResponse } from '@signet/types';
import { unlinkByChallenge, type UnlinkFailure } from '@/lib/server/cli-unlink';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * `POST /api/cli/unlink` — detach a deploy wallet, proving control of its key.
 *
 * Called by the CLI, never a browser page: there is no session and no
 * same-origin check, because the caller authenticates by signing a SEP-10
 * challenge for the wallet it wants removed. The browser has its own path for
 * this (`account.unlinkWallet`, session-authenticated), which is why this one
 * does not need to reach a profile the way that one does.
 *
 * Unlike attaching, this needs only key control — see `lib/server/cli-unlink.ts`
 * for why withdrawing an attestation is not the same trust question as making
 * one.
 */
const OUTCOME_STATUS: Record<UnlinkFailure, number> = {
  unavailable: 503,
  'bad-challenge': 401,
  replayed: 401,
  'not-linked': 404,
  'primary-wallet': 409,
};

const OUTCOME_MESSAGE: Record<UnlinkFailure, string> = {
  unavailable:
    'CLI wallet unlinking requires a database, and this deployment has none configured. This is a deployment configuration problem, not something you did. The operator needs to provision DATABASE_URL.',
  'bad-challenge': 'Invalid or unsigned challenge transaction',
  replayed: 'This signed challenge has already been used',
  'not-linked': 'That wallet is not linked to any profile',
  'primary-wallet':
    'That wallet is the profile’s primary wallet — releasing it is an on-chain registry operation, not an unlink',
};

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:unlink', LIMITS.cliPairComplete);
  if (limited) return limited;

  const { transaction } = (await req.json().catch(() => ({}))) as Partial<UnlinkRequest>;
  if (!transaction) {
    return NextResponse.json(
      { error: 'transaction is required', code: 'bad-request' } satisfies ErrorBody,
      { status: 400 },
    );
  }

  const result = await unlinkByChallenge(transaction);
  if (!result.ok) {
    return NextResponse.json(
      { error: OUTCOME_MESSAGE[result.reason], code: result.reason } satisfies ErrorBody,
      { status: OUTCOME_STATUS[result.reason], headers: { 'cache-control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { ok: true, wallet: result.pubkey, handle: result.handle } satisfies UnlinkResponse,
    { headers: { 'cache-control': 'no-store' } },
  );
}
