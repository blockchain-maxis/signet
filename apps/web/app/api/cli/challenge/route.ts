import { NextResponse } from 'next/server';
import { createChallenge } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const pubkey = searchParams.get('pubkey');

  if (!pubkey) {
    return NextResponse.json({ error: 'Missing pubkey' }, { status: 400 });
  }

  const challenge = createChallenge(pubkey);
  return NextResponse.json({ challenge });
}
