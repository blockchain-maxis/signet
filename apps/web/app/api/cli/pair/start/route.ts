import { NextResponse } from 'next/server';
import { startPairing } from '@/lib/server/pairing';
import { getNetworkPassphrase } from '@/lib/sep10';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * `POST /api/cli/pair/start` — mint a pairing for the `stellar signet pair`
 * CLI flow. Unauthenticated by design: the CLI has no session and no signed
 * challenge yet at this point, it is only asking for something to show the
 * user (a `state` to render as a code/link for the browser step).
 *
 * `network` is the Stellar network passphrase the CLI is running against
 * (mirroring `network_passphrase` from `GET /api/auth/sep10`), checked again
 * at `complete` against this deployment's actual configured network — a CLI
 * on testnet pairing against a mainnet deployment (or vice versa) fails
 * there with a distinct `network-mismatch`, rather than silently binding a
 * wallet on the wrong network.
 */
export async function POST(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:pair:start', LIMITS.cliPairStart);
  if (limited) return limited;

  const { network } = (await req.json().catch(() => ({}))) as { network?: string };

  const pairing = await startPairing(network || getNetworkPassphrase());
  if (!pairing) {
    return NextResponse.json({ error: 'Pairing is unavailable' }, { status: 503 });
  }

  return NextResponse.json(pairing, { headers: { 'cache-control': 'no-store' } });
}
