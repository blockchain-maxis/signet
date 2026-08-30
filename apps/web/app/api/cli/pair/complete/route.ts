import { NextResponse } from 'next/server';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { completePairingManually } from '@/lib/server/cli-pairing';
import { pollOutcomeResponse } from '@/lib/server/cli-pairing-http';

// Called by the CLI, not a browser page — no same-origin check. The manual
// fallback: the developer types the code the browser showed after approving.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:pair:complete', LIMITS.cliPairComplete);
  if (limited) return limited;

  const { pairingCode, completionCode } = (await req.json().catch(() => ({}))) as {
    pairingCode?: string;
    completionCode?: string;
  };
  if (!pairingCode || !completionCode) {
    return NextResponse.json({ error: 'Missing pairingCode or completionCode' }, { status: 400 });
  }

  const outcome = await completePairingManually(pairingCode, completionCode);
  return pollOutcomeResponse(outcome);
}
