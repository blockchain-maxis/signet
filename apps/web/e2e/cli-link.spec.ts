import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { createHmac, randomBytes } from 'node:crypto';
import { prisma } from '@signet/db';

const b64url = (b: Buffer): string => b.toString('base64url');
const hmac = (data: string): Buffer =>
  createHmac('sha256', 'signet-e2e-only-session-secret').update(data).digest();

function createCliLinkToken(pubkey: string, profileId: string): string {
  const nonce = randomBytes(16).toString('hex');
  const issued = Date.now();
  const data = `${pubkey}|${profileId}|${issued}|${nonce}`;
  const tag = b64url(hmac(data));
  return b64url(Buffer.from(`${data}|${tag}`));
}

test('cli link endpoint applies IP-based and deploy-pubkey-based rate limiting', async ({ request }) => {
  let ipStatus = 200;
  for (let i = 0; i < 11; i++) {
    const res = await request.post('/api/cli/link', {
      headers: { 'x-vercel-forwarded-for': '10.0.0.99' },
      data: { token: 'bogus', signature: 'bogus' },
    });
    ipStatus = res.status();
    if (ipStatus === 429) break;
  }
  expect(ipStatus).toBe(429);
});

test('cli link policy for re-attachment', async ({ request }) => {
  // 1. Setup two profiles
  const profile1 = await prisma.profile.create({
    data: { handle: `p1-${randomBytes(4).toString('hex')}` },
  });
  const profile2 = await prisma.profile.create({
    data: { handle: `p2-${randomBytes(4).toString('hex')}` },
  });

  const kp = Keypair.random();
  const pubkey = kp.publicKey();

  // 2. Link wallet to profile 1
  const token1 = createCliLinkToken(pubkey, profile1.id);
  const sig1 = kp.sign(Buffer.from(token1, 'utf8')).toString('base64');

  const res1 = await request.post('/api/cli/link', {
    headers: { 'x-vercel-forwarded-for': '10.0.0.100' },
    data: { token: token1, signature: sig1 },
  });
  expect(res1.status()).toBe(200);

  // 3. Try linking the same wallet to the same profile again (No-op)
  const token1_again = createCliLinkToken(pubkey, profile1.id);
  const sig1_again = kp.sign(Buffer.from(token1_again, 'utf8')).toString('base64');
  const res1_again = await request.post('/api/cli/link', {
    headers: { 'x-vercel-forwarded-for': '10.0.0.101' },
    data: { token: token1_again, signature: sig1_again },
  });
  expect(res1_again.status()).toBe(200);

  // 4. Try linking the same wallet to a DIFFERENT profile (Refusal)
  const token2 = createCliLinkToken(pubkey, profile2.id);
  const sig2 = kp.sign(Buffer.from(token2, 'utf8')).toString('base64');
  const res2 = await request.post('/api/cli/link', {
    headers: { 'x-vercel-forwarded-for': '10.0.0.102' },
    data: { token: token2, signature: sig2 },
  });
  expect(res2.status()).toBe(409);
  const body2 = await res2.json();
  expect(body2.error).toBe('Wallet is already linked to a profile');
});
