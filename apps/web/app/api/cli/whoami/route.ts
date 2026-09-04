import { NextResponse } from 'next/server';
import { getAccount } from '@/lib/server/account';
import { getNetworkPassphrase } from '@/lib/sep10';
import { isValidStellarAddress } from '@/lib/stellar-address';
import { LIMITS, enforceRateLimit } from '@/lib/rate-limit-http';

export const runtime = 'nodejs';

/**
 * `GET /api/cli/whoami?publicKey=G…` — which handle, if any, a deploy account
 * is currently attributed to.
 *
 * Answers the most common support question a linking CLI gets: "which account
 * am I actually linked as?" (#260). The CLI knows its own key and deployment
 * without asking; the handle is the one part only the server can tell it.
 *
 * Called by the CLI, never a browser page, so no same-origin check and no
 * session. Unauthenticated by design and no new disclosure: `getAccount`
 * resolves the same address → handle mapping the public `registry.lookup`
 * procedure already exposes, and a handle→wallet binding is public on-chain
 * data. Rate limited on the shared read budget because it is a plain lookup —
 * it mints nothing and signs nothing.
 */
export async function GET(req: Request) {
  const limited = await enforceRateLimit(req, 'cli:whoami', LIMITS.read);
  if (limited) return limited;

  const publicKey = new URL(req.url).searchParams.get('publicKey');
  if (!publicKey || !isValidStellarAddress(publicKey)) {
    return NextResponse.json(
      { error: 'publicKey is required and must be a valid Stellar address' },
      { status: 400 },
    );
  }

  const account = await getAccount(publicKey);

  return NextResponse.json(
    {
      publicKey,
      handle: account.handle ?? null,
      linked: Boolean(account.handle),
      network: getNetworkPassphrase(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
