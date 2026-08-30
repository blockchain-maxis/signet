import { NextResponse } from 'next/server';
import { createCliPairingCode } from '@/lib/cli-auth';
import { enforceRateLimit, LIMITS } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const ipLimited = await enforceRateLimit(req, 'cli:pair:start', LIMITS.cliPairStart);
  if (ipLimited) return ipLimited;

  const { pubkey, network, state } = await req.json().catch(() => ({}));

  if (!pubkey || !network || !state) {
    return NextResponse.json({ error: 'Missing pubkey, network, or state' }, { status: 400 });
  }

  // The pairing code is a short-lived token that includes the CLI's public key,
  // the target network, and a callback state identifier.
  const code = createCliPairingCode(pubkey, network, state);

  return NextResponse.json({ code });
}
