import { NextResponse } from 'next/server';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { pollPairing } from '@/lib/server/cli-pairing';
import { pollOutcomeResponse } from '@/lib/server/cli-pairing-http';

// Called by the CLI, not a browser page — no same-origin check.
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:pair:status', LIMITS.cliPairStatus);
  if (limited) return limited;

  const pollToken = new URL(req.url).searchParams.get('pollToken');
  if (!pollToken) {
    return NextResponse.json({ error: 'Missing pollToken' }, { status: 400 });
  }

  const outcome = await pollPairing(pollToken);
  return pollOutcomeResponse(outcome);
}
