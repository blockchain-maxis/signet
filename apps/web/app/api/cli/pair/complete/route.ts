import { NextResponse } from 'next/server';
import { completePairing, type CompleteFailure } from '@/lib/server/pairing';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * `POST /api/cli/pair/complete` — the trust boundary of the whole pairing
 * feature.
 *
 * Called by the CLI once it holds a SEP-10 challenge signed by the deploy
 * account (produced via `stellar tx sign`, so the CLI never touches key
 * material directly). Requires two independent proofs before a `Wallet` row
 * is written: an already-**approved** pairing (proof the handle's owner
 * consented, via the browser session in `pair/approve`) plus a valid signed
 * challenge for *this* pairing's network (proof of the deploy account). See
 * `lib/server/pairing.ts` for the full trust model and the failure modes
 * enumerated below.
 *
 * Deliberately unauthenticated at the HTTP layer — the CLI has no session
 * cookie, no browser, no same-origin story. Authentication is entirely the
 * signed challenge; every failure path below fails closed.
 */
const FAILURE_STATUS: Record<CompleteFailure, number> = {
  unavailable: 503,
  'not-found': 404,
  expired: 410,
  'not-approved': 409,
  'already-completed': 409,
  'network-mismatch': 400,
  'bad-challenge': 401,
  'key-mismatch': 403,
  'bad-handoff': 403,
  replayed: 401,
  'wallet-bound-elsewhere': 409,
};

const FAILURE_MESSAGE: Record<CompleteFailure, string> = {
  unavailable: 'Pairing is unavailable',
  'not-found': 'Pairing not found — restart it from the CLI',
  expired: 'This pairing has expired — restart it from the CLI',
  'not-approved': 'This pairing has not been approved in the browser yet',
  'already-completed': 'This pairing has already been completed',
  'network-mismatch': "This pairing's network does not match the deployment's configured network",
  'bad-challenge': 'Invalid or unsigned challenge transaction',
  'key-mismatch':
    'This challenge was signed by a different account than the one approved in the browser',
  'bad-handoff': 'That confirmation code does not match the one shown in the browser',
  replayed: 'This signed challenge has already been used',
  'wallet-bound-elsewhere': 'This deploy account is already bound to a different profile',
};

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:pair:complete', LIMITS.cliPairComplete);
  if (limited) return limited;

  const { state, transaction, handoffCode } = (await req.json().catch(() => ({}))) as {
    state?: string;
    transaction?: string;
    handoffCode?: string;
  };
  if (!state || !transaction) {
    return NextResponse.json({ error: 'state and transaction are required' }, { status: 400 });
  }

  const result = await completePairing(state, transaction, undefined, handoffCode);
  if (!result.ok) {
    logger.warn({ state, reason: result.reason }, 'cli.pairCompleteFailed');
    return NextResponse.json(
      { error: FAILURE_MESSAGE[result.reason] },
      { status: FAILURE_STATUS[result.reason], headers: { 'cache-control': 'no-store' } },
    );
  }

  logger.info({ state, pubkey: result.wallet.pubkey }, 'cli.pairCompleted');
  return NextResponse.json(
    { ok: true, wallet: result.wallet.pubkey, handle: result.handle },
    { headers: { 'cache-control': 'no-store' } },
  );
}
