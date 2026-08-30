import { NextResponse } from 'next/server';
import { getLinkState } from '@/lib/link-pairing';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * Polled by `signet link` while it waits. Always answers 200 with a terminal
 * or pending state — never an error a polling client would have to interpret —
 * so the CLI's bounded loop just keeps waiting until an answer settles in.
 */
export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'link:status', LIMITS.read);
  if (limited) return limited;

  const code = new URL(req.url).searchParams.get('code');
  if (!code) {
    return NextResponse.json({ error: 'Missing pairing code' }, { status: 400 });
  }

  return NextResponse.json(
    { state: getLinkState(code) },
    { headers: { 'cache-control': 'no-store' } },
  );
}