import { NextResponse } from 'next/server';
import { approveLinkPair } from '@/lib/link-pairing';
import { isSameOrigin } from '@/lib/security';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * The browser-approval half of `signet link`: the developer clicks "Approve"
 * on the pairing page and this marks the code approved, which the CLI's next
 * poll observes. A code that expired is rejected with 410 — the CLI gives up
 * on the same TTL, so it will never still be polling.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
  }
  const limited = await enforceRateLimit(req, 'link:approve', LIMITS.linkApprove);
  if (limited) return limited;

  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!code) {
    return NextResponse.json({ error: 'Missing pairing code' }, { status: 400 });
  }

  switch (approveLinkPair(code)) {
    case 'ok':
      return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
    case 'expired':
      return NextResponse.json(
        { error: 'Pairing code expired' },
        { status: 410, headers: { 'cache-control': 'no-store' } },
      );
    case 'not-found':
      return NextResponse.json({ error: 'Unknown pairing code' }, { status: 404 });
  }
}