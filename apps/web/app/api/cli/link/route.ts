import { NextResponse } from 'next/server';
import { verifySignature } from '@/lib/auth';
import { verifyCliLinkToken } from '@/lib/cli-auth';
import { prisma } from '@signet/db';
import { logger } from '@/lib/logger';
import { consumeNonce } from '@/lib/nonce-store';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const { token, signature } = await req.json().catch(() => ({}));

  if (!token || !signature) {
    return NextResponse.json({ error: 'Missing token or signature' }, { status: 400 });
  }

  const validToken = verifyCliLinkToken(token);
  if (!validToken) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  const { pubkey, profileId } = validToken;

  // Verify the signature. The CLI signed the raw token string.
  const isSignatureValid = await verifySignature(pubkey, token, signature);
  if (!isSignatureValid) {
    logger.warn({ pubkey }, 'cli.invalidSignature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Prevent replay attacks
  const nonceConsumed = await consumeNonce(`cli-link:${token}`, 5 * 60 * 1000);
  if (!nonceConsumed) {
    return NextResponse.json({ error: 'Token has already been used' }, { status: 401 });
  }

  try {
    await prisma.wallet.create({
      data: {
        profileId: profileId,
        pubkey: pubkey,
        source: 'curated',
        isPrimary: false,
      },
    });
    logger.info({ pubkey, profileId }, 'cli.linkedWallet');
  } catch (error: any) {
    if (error.code === 'P2002') {
      return NextResponse.json({ error: 'Wallet is already linked to a profile' }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true });
}
