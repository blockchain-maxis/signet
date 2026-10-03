import { NextResponse } from 'next/server';
import type { ErrorBody, PairStartRequest, PairStartResponse } from '@signet/types';
import { checkStartNetwork, checkStartPublicKey, startPairing } from '@/lib/server/pairing';
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

  const { network, publicKey } = (await req.json().catch(() => ({}))) as Partial<PairStartRequest>;

  // The deploy key is REQUIRED (#596). A keyless pairing used to reach the
  // approval page with an enabled Approve button next to "Not declared by the
  // CLI" — and since this endpoint is unauthenticated, anyone could mint one,
  // get a signed-in user to open the link, and then complete it with their
  // own key. Shape check only beyond that — the claim is checked for real at
  // `complete`, where the challenge has to be signed by it.
  if (!checkStartPublicKey(publicKey)) {
    return NextResponse.json(
      {
        error:
          'publicKey is required and must be a Stellar G… address. Update the signet CLI if yours does not send one.',
        code: 'invalid-public-key',
      } satisfies ErrorBody,
      { status: 400 },
    );
  }

  // The wire uses network names (#616). Unknown or missing → 400; a network
  // that doesn't match this deployment's → 400 naming both, BEFORE a row
  // exists — the old flow only surfaced the mismatch at `complete`, after
  // the user had already approved in the browser.
  const checked = checkStartNetwork(network);
  if (!checked.ok) {
    if (checked.error === 'network-mismatch') {
      return NextResponse.json(
        {
          error: `Network mismatch: the CLI requested "${checked.requested}" but this deployment is configured for "${checked.configured}".`,
          code: 'network-mismatch',
        } satisfies ErrorBody,
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error: 'network must be a Stellar network name, e.g. "testnet" or "mainnet"',
        code: 'unknown-network',
      } satisfies ErrorBody,
      { status: 400 },
    );
  }

  const pairing = await startPairing(checked.network, publicKey);
  if (!pairing) {
    return NextResponse.json(
      {
        error:
          'CLI linking requires a database, and this deployment has none configured. This is a deployment configuration problem, not something you did. The operator needs to provision DATABASE_URL.',
        code: 'unavailable',
      } satisfies ErrorBody,
      { status: 503 },
    );
  }

  return NextResponse.json(pairing satisfies PairStartResponse, {
    headers: { 'cache-control': 'no-store' },
  });
}
