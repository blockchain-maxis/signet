import { NextResponse } from 'next/server';
import { rejectPairing } from '@/lib/server/pairing';
import { isSameOrigin } from '@/lib/security';
import { currentAddress } from '@/lib/server/session';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * `POST /api/cli/pair/reject` — the developer refused the pairing in the
 * browser.
 *
 * The other half of `pair/approve`, and called from the same page. Recording a
 * refusal is what lets the CLI say "rejected" and exit straight away instead of
 * polling until the pairing's TTL runs out; a flow that cannot tell "no" from
 * "not yet" reads as a hang.
 *
 * Same-origin plus the session cookie's `SameSite=Lax` is the CSRF story, as
 * for the other mutating routes. A session is required so a refusal is an act
 * by a signed-in person, but — unlike `approve` — no profile is: nothing is
 * being bound, and a developer who has not claimed a handle still has to be
 * able to refuse a pairing they did not start.
 */
const OUTCOME_STATUS: Record<string, number> = {
  'not-found': 404,
  expired: 410,
  'already-used': 409,
  unavailable: 503,
};

const OUTCOME_MESSAGE: Record<string, string> = {
  'not-found': 'Pairing not found — it may have already been used',
  expired: 'This pairing has expired — restart it from the CLI',
  'already-used': 'This pairing has already been answered',
  unavailable:
    'CLI linking requires a database, and this deployment has none configured. This is a deployment configuration problem, not something you did. The operator needs to provision DATABASE_URL.',
};

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limited = await enforceRateLimit(req, 'cli:pair:reject', LIMITS.authRevoke);
  if (limited) return limited;

  const address = await currentAddress();
  if (!address) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { state } = (await req.json().catch(() => ({}))) as { state?: string };
  if (!state) return NextResponse.json({ error: 'state is required' }, { status: 400 });

  const outcome = await rejectPairing(state);
  if (outcome !== 'ok') {
    return NextResponse.json(
      { error: OUTCOME_MESSAGE[outcome] ?? outcome },
      { status: OUTCOME_STATUS[outcome] ?? 400 },
    );
  }

  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
