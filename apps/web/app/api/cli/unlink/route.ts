import { NextResponse } from 'next/server';
import { redeemChallenge } from '@/lib/auth';
import { prisma } from '@signet/db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { pubkey, challenge, signature } = await req.json().catch(() => ({}));

  if (!pubkey || !challenge || !signature) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // The CLI proves ownership of the deploy key by signing a challenge.
  const outcome = await redeemChallenge(pubkey, challenge, signature);
  if (outcome !== 'ok') {
    logger.warn({ pubkey, outcome }, 'cli.challengeRejected');
    return NextResponse.json({ error: 'Invalid challenge or signature' }, { status: 401 });
  }

  // Remove the deploy key from its profile.
  const deleted = await prisma.wallet.delete({
    where: { pubkey: pubkey },
  }).catch(() => null);

  if (!deleted) {
    return NextResponse.json({ error: 'Deploy key is not linked to any profile' }, { status: 404 });
  }

  logger.info({ pubkey }, 'cli.unlinkedWallet');
  return NextResponse.json({ ok: true });
}
