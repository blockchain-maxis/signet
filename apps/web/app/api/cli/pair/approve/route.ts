import { NextResponse } from 'next/server';
import type {
  ApproveFailure,
  ErrorBody,
  PairApproveRequest,
  PairApproveResponse,
} from '@signet/types';
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
const OUTCOME_STATUS: Record<ApproveFailure, number> = {
  'not-found': 404,
  expired: 410,
  'already-used': 409,
  'no-profile': 409,
  'no-key': 409,
  unavailable: 503,
};

const OUTCOME_MESSAGE: Record<ApproveFailure, string> = {
  'not-found': 'Pairing not found — it may have already been used',
  expired: 'This pairing has expired — restart it from the CLI',
  'already-used': 'This pairing has already been approved',
  'no-profile': 'Claim a handle before pairing a CLI',
  'no-key':
    'This pairing never declared a deploy key, so approving it would be consent to an unknown wallet. Start the link again from an up-to-date CLI.',
  unavailable:
    'CLI linking requires a database, and this deployment has none configured. This is a deployment configuration problem, not something you did. The operator needs to provision DATABASE_URL.',
};

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json(
      { error: 'Cross-origin request rejected', code: 'cross-origin' } satisfies ErrorBody,
      { status: 403 },
    );
  }
  const limited = await enforceRateLimit(req, 'cli:pair:approve', LIMITS.authRevoke);
  if (limited) return limited;

  const address = await currentAddress();
  if (!address) {
    return NextResponse.json(
      { error: 'Not signed in', code: 'not-signed-in' } satisfies ErrorBody,
      { status: 401 },
    );
  }

  const { state } = (await req.json().catch(() => ({}))) as Partial<PairApproveRequest>;
  if (!state) {
    return NextResponse.json(
      { error: 'state is required', code: 'bad-request' } satisfies ErrorBody,
      { status: 400 },
    );
  }

  const result = await approvePairing(state, address);
  if (result.outcome !== 'ok') {
    return NextResponse.json(
      { error: OUTCOME_MESSAGE[result.outcome], code: result.outcome } satisfies ErrorBody,
      { status: OUTCOME_STATUS[result.outcome] },
    );
  }

  // The handoff code is shown to the developer so they can paste it into a
  // terminal the browser cannot reach directly (#273). Returned only here, to
  // the session that just approved.
  return NextResponse.json(
    { ok: true, handoffCode: result.handoffCode } satisfies PairApproveResponse,
    { headers: { 'cache-control': 'no-store' } },
  );
}
