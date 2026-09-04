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

  const { network, publicKey } = (await req.json().catch(() => ({}))) as {
    network?: string;
    publicKey?: string;
  };

  // Shape check only — this is an unauthenticated claim, and it is checked for
  // real at `complete`, where the challenge has to be signed by it. Rejecting
  // a malformed value here just keeps junk out of the approval page.
  if (publicKey !== undefined && !/^G[A-Z2-7]{55}$/.test(publicKey)) {
    return NextResponse.json({ error: 'publicKey must be a Stellar G… address' }, { status: 400 });
  }

  const pairing = await startPairing(network || getNetworkPassphrase(), publicKey ?? null);
  if (!pairing) {
    return NextResponse.json(
      {
        error:
          'CLI linking requires a database, and this deployment has none configured. This is a deployment configuration problem, not something you did. The operator needs to provision DATABASE_URL.',
      },
      { status: 503 },
    );
  }

  return NextResponse.json(pairing, { headers: { 'cache-control': 'no-store' } });
}
