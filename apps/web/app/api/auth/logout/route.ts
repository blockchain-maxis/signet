import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';
import { isSameOrigin } from '@/lib/security';
import { currentSessionClaims } from '@/lib/server/session';
import { revokeSession } from '@/lib/session-revocation';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * End this session.
 *
 * Clearing the cookie only removes the browser's copy. The token itself stayed
 * valid for the rest of its seven days, so anything that had read it off the
 * device — a shared machine's cookie jar, a logging sidecar — kept a working
 * session after the user had signed out. Revoking the session id closes that,
 * and it is scoped to this one session: the user's other devices stay signed
 * in, which is what "sign out" means everywhere else.
 *
 * The cookie is cleared even if the revocation write fails, because the local
 * effect of signing out should never depend on the shared store being up. The
 * failure is logged and reported, so the caller can retry rather than assume
 * the token is dead.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }

  const claims = await currentSessionClaims();
  let revoked = false;
  if (claims?.sid) {
    try {
      await revokeSession(claims.sid, claims.exp);
      revoked = true;
    } catch (err) {
      logger.error({ err: String(err), address: claims.address }, 'auth.logoutRevokeFailed');
    }
  }

  const res = NextResponse.json({ ok: true, revoked });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
