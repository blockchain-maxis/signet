import { NextResponse } from 'next/server';
import { createLinkPair } from '@/lib/link-pairing';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * Start a `signet link` session: mint a pairing code and hand the CLI
 * everything it needs to wait for browser approval — the code to print, the
 * URL to open, and the TTL it must wait no longer than.
 *
 * Deliberately not same-origin-gated: this is the CLI, not a browser, and it
 * sends no cookies, so the CSRF check has nothing to protect. A pending
 * pairing is inert until approved, and creation is rate-limited.
 */
export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'link:device', LIMITS.linkDevice);
  if (limited) return limited;

  const pair = createLinkPair();
  const origin = new URL(req.url).origin;
  return NextResponse.json(
    {
      pairingCode: pair.pairingCode,
      verificationUrl: `${origin}/link/${pair.pairingCode}`,
      ttlMs: pair.ttlMs,
      intervalMs: pair.intervalMs,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}