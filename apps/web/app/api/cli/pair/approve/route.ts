import { NextResponse } from 'next/server';
import { isSameOrigin } from '@/lib/security';
import { currentAddress } from '@/lib/server/session';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { approvePairing } from '@/lib/server/cli-pairing';
import { pairingErrorResponse } from '@/lib/server/cli-pairing-http';

// Called by the browser approval page — this is the "signed-in session
// authorized to modify its own profile" proof, so it's authenticated and
// same-origin, unlike the CLI-facing routes alongside it.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limited = await enforceRateLimit(req, 'cli:pair:approve', LIMITS.cliPairApprove);
  if (limited) return limited;

  const address = await currentAddress();
  if (!address) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const { pairingCode } = (await req.json().catch(() => ({}))) as { pairingCode?: string };
  if (!pairingCode) {
    return NextResponse.json({ error: 'Missing pairingCode' }, { status: 400 });
  }

  try {
    const result = await approvePairing(pairingCode, address);
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    return pairingErrorResponse(err);
  }
}
