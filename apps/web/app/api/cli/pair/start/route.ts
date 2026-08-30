import { NextResponse } from 'next/server';
import { isValidStellarAddress } from '@/lib/stellar-address';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { startPairing } from '@/lib/server/cli-pairing';
import { pairingErrorResponse } from '@/lib/server/cli-pairing-http';

// Called by the CLI, not a browser page — no same-origin check.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:pair:start', LIMITS.cliPairStart);
  if (limited) return limited;

  const { publicKey, network } = (await req.json().catch(() => ({}))) as {
    publicKey?: string;
    network?: string;
  };
  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return NextResponse.json({ error: 'Invalid publicKey' }, { status: 400 });
  }

  try {
    const started = await startPairing(publicKey, network === 'mainnet' ? 'mainnet' : 'testnet');
    return NextResponse.json(started, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return pairingErrorResponse(err);
  }
}
