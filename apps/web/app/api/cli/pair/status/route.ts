import { NextResponse } from 'next/server';
import { pollPairing } from '@/lib/server/pairing';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * `GET /api/cli/pair/status?pollToken=…` — the polling fallback (#273).
 *
 * Loopback is unreachable for a whole class of real setups: a remote SSH
 * session, a container with an unmapped port, a browser locked down against
 * localhost. Those developers are a core audience — they are the ones
 * deploying Soroban contracts from a remote box — and without this the link
 * flow simply does not exist for them.
 *
 * Called by the CLI, never a browser page, so there is no same-origin check
 * and no session: the caller authenticates by holding the poll token minted
 * for this pairing at `start`. That token is deliberately not the pairing
 * code — the code goes in the URL the developer opens and may well get pasted
 * somewhere public, and seeing a link should not confer the ability to watch
 * the pairing behind it.
 *
 * This only reads progress. Approval still needs the browser session and
 * attachment still needs the signed challenge, so the fallback path reaches
 * the same trust boundary as the loopback one rather than going around it.
 */
export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:pair:status', LIMITS.cliPairStatus);
  if (limited) return limited;

  const pollToken = new URL(req.url).searchParams.get('pollToken');
  if (!pollToken) {
    return NextResponse.json({ error: 'pollToken is required' }, { status: 400 });
  }

  const result = await pollPairing(pollToken);
  if (!result.ok) {
    // An unknown token and a wrong token are the same answer on purpose:
    // this endpoint must not become an oracle for which tokens are real.
    const status = result.reason === 'unavailable' ? 503 : 404;
    const error = result.reason === 'unavailable' ? 'Pairing is unavailable' : 'Pairing not found';
    return NextResponse.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
  }

  return NextResponse.json({ status: result.status }, { headers: { 'cache-control': 'no-store' } });
}
