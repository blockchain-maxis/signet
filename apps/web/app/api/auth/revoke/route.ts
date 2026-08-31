import { NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_TTL_MS } from '@/lib/auth';
import { isSameOrigin } from '@/lib/security';
import { currentAddress, currentSessionClaims } from '@/lib/server/session';
import { revokeAddress } from '@/lib/session-revocation';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * Revoke this wallet's sessions.
 *
 * `POST { "scope": "others" }` (the default) signs out every other device and
 * keeps the caller signed in here — the "I was signed in on a machine I no
 * longer control" lever, which until now did not exist at any granularity
 * short of signing out every user of the product.
 *
 * `POST { "scope": "all" }` signs out everything including this device, for
 * the case where the current device is the suspect one.
 *
 * Self-service only: the scope is the caller's own address, taken from the
 * session, never from the body. Same-origin plus the SameSite=Lax cookie is
 * the CSRF story, as for the other mutating routes — a forged cross-site call
 * would be a denial of service, not an escalation, but a sign-out nobody asked
 * for is still a sign-out.
 */
const SCOPES = new Set(['others', 'all']);

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limited = await enforceRateLimit(req, 'auth:revoke', LIMITS.authRevoke);
  if (limited) return limited;

  const address = await currentAddress();
  if (!address) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { scope = 'others' } = (await req.json().catch(() => ({}))) as { scope?: string };
  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: 'scope must be "others" or "all"' }, { status: 400 });
  }

  const claims = await currentSessionClaims();
  // A session minted before session ids existed cannot be spared — there is
  // nothing to name it by — so "others" degrades to "all" rather than quietly
  // reporting that this device stayed signed in when it did not.
  const exceptSid = scope === 'others' ? claims?.sid : undefined;
  const effective = scope === 'others' && !exceptSid ? 'all' : scope;

  // `until` has to outlive the newest session the rule could still reject,
  // which is one minted a moment before the cut-off.
  try {
    await revokeAddress(address, { exceptSid, until: Date.now() + SESSION_TTL_MS });
  } catch (err) {
    logger.error({ err: String(err), address, scope }, 'auth.revokeFailed');
    return NextResponse.json(
      { error: 'Could not record the revocation — nothing was signed out. Try again.' },
      { status: 503 },
    );
  }

  logger.info({ address, scope: effective }, 'auth.sessionsRevoked');
  const res = NextResponse.json({ ok: true, scope: effective });
  if (effective === 'all') res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
