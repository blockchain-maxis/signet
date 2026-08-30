import { test, expect } from '@playwright/test';
import { verifyCliPairingCode } from '../lib/cli-auth';

test('POST /api/cli/pair/start returns a verifiable short-lived pairing code', async ({ request }) => {
  const reqBody = {
    pubkey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    network: 'testnet',
    state: 'callback123',
  };

  const res = await request.post('/api/cli/pair/start', {
    headers: { 'x-vercel-forwarded-for': '10.0.0.9' },
    data: reqBody,
  });

  expect(res.status()).toBe(200);
  const { code } = await res.json();
  expect(typeof code).toBe('string');

  const verified = verifyCliPairingCode(code);
  expect(verified).not.toBeNull();
  expect(verified?.pubkey).toBe(reqBody.pubkey);
  expect(verified?.network).toBe(reqBody.network);
  expect(verified?.state).toBe(reqBody.state);
});

test('POST /api/cli/pair/start enforces rate limiting', async ({ request }) => {
  let ipStatus = 200;
  for (let i = 0; i < 21; i++) {
    const res = await request.post('/api/cli/pair/start', {
      headers: { 'x-vercel-forwarded-for': '10.0.0.8' },
      data: {
        pubkey: 'GBBB',
        network: 'testnet',
        state: 'callback123',
      },
    });
    ipStatus = res.status();
    if (ipStatus === 429) break;
  }
  expect(ipStatus).toBe(429);
});
