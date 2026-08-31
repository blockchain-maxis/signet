import { cookies } from 'next/headers';
import { readSession, verifySession, SESSION_COOKIE } from '../auth.ts';
import type { SessionClaims } from '../session-revocation.ts';

/**
 * Resolve the signed-in wallet address from the session cookie, server-side.
 * Returns null when there is no valid session. Used by dashboard server
 * components (the `(dashboard)` layout already gates rendering on this).
 */
export async function currentAddress(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySession(token);
}

/**
 * The claims of the session cookie — authentic and unexpired, but *not*
 * checked against the revocation list, which is what the name says.
 *
 * Route handlers that act on the current session itself need its `sid`:
 * logout revokes it, "sign out my other devices" spares it. Both are willing
 * to act on an already-revoked cookie (revoking twice is harmless), so neither
 * needs the list read that `currentAddress()` does.
 */
export async function currentSessionClaims(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return readSession(token);
}
