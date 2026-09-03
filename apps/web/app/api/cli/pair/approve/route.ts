import { NextResponse } from 'next/server';
import { approvePairing } from '@/lib/server/pairing';
import { isSameOrigin } from '@/lib/security';
import { currentAddress } from '@/lib/server/session';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * `POST /api/cli/pair/approve` — the browser side of the pairing.
 *
 * Called by this app's own frontend (never the CLI: it has no session
 * cookie), once the signed-in user confirms "yes, pair this CLI with my
 * account". Proves ownership of the *handle* via the session; proof of the
 * deploy account itself happens later, in `complete`. Same-origin + the
 * session cookie's `SameSite=Lax` is the CSRF story, as for the other
 * mutating routes.
 */
const OUTCOME_STATUS: Record<string, number> = {
  'not-found': 404,
  expired: 410,
  'already-used': 409,
  'no-profile': 409,
  unavailable: 503,
};

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limited = await enforceRateLimit(req, 'cli:pair:approve', LIMITS.authRevoke);
  if (limited) return limited;

  const address = await currentAddress();
  if (!address) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { state } = (await req.json().catch(() => ({}))) as { state?: string };
  if (!state) return NextResponse.json({ error: 'state is required' }, { status: 400 });

  const outcome = await approvePairing(state, address);
  if (outcome !== 'ok') {
    const messages: Record<string, string> = {
      'not-found': 'Pairing not found — it may have already been used',
      expired: 'This pairing has expired — restart it from the CLI',
      'already-used': 'This pairing has already been approved',
      'no-profile': 'Claim a handle before pairing a CLI',
      unavailable: 'Pairing is unavailable',
    };
    return NextResponse.json(
      { error: messages[outcome] ?? outcome },
      { status: OUTCOME_STATUS[outcome] ?? 400 },
    );
  }

  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
