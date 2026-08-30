import { NextResponse } from 'next/server';
import { CliPairingError, type PollOutcome } from './cli-pairing.ts';

/** Map a `CliPairingError` to the right HTTP status — shared by every `/api/cli/pair/*` route. */
export function pairingErrorResponse(err: unknown): NextResponse {
  if (err instanceof CliPairingError) {
    const status =
      err.code === 'not-found'
        ? 404
        : err.code === 'expired'
          ? 410
          : err.code === 'no-database'
            ? 503
            : err.code === 'bad-signature' || err.code === 'invalid-public-key'
              ? 400
              : 409; // unproven | invalid-state | no-profile
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
}

/** Map a `PollOutcome` (shared by the poll and manual-complete endpoints) to a response. */
export function pollOutcomeResponse(outcome: PollOutcome): NextResponse {
  const status =
    outcome.state === 'approved' ? 200 : outcome.state === 'pending' ? 202 : outcome.state === 'expired' ? 410 : 404;
  return NextResponse.json(outcome, { status, headers: { 'cache-control': 'no-store' } });
}
