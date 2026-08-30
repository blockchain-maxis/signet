import { NextResponse } from 'next/server';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { submitPairingProof } from '@/lib/server/cli-pairing';
import { pairingErrorResponse } from '@/lib/server/cli-pairing-http';

// Called by the CLI, not a browser page — no same-origin check.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:pair:proof', LIMITS.cliPairProof);
  if (limited) return limited;

  const { pollToken, signature } = (await req.json().catch(() => ({}))) as {
    pollToken?: string;
    signature?: string;
  };
  if (!pollToken || !signature) {
    return NextResponse.json({ error: 'Missing pollToken or signature' }, { status: 400 });
  }

  try {
    await submitPairingProof(pollToken, signature);
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return pairingErrorResponse(err);
  }
}
