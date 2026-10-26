import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  NetworkError,
  NotFoundError,
  RateLimitedError,
  UnavailableError,
  ValidationError,
  type ProfileResponse,
} from '@signet/sdk';
import { handler } from './server.ts';
import { verifyApplicant, type Signet } from './verify.ts';

const WALLET = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const CLI_WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const OTHER = 'CA3D5KRYMCMCZVACBBQINPBVYQ4WY2OA36IC3PIGGEJNVMGT4DXFV3A6';

const profile = {
  handle: 'alice',
  displayName: null,
  bio: null,
  primaryWallet: WALLET,
  joinedAt: null,
  network: 'testnet',
  archived: false,
  counts: { contracts: 1, wallets: 2, invocations: 0 },
  countsAreLowerBounds: false,
} as unknown as ProfileResponse;

const wallets = [
  {
    address: WALLET,
    isPrimary: true,
    source: 'onchain',
    linkedAt: null,
    indexingPending: false,
    network: 'testnet',
  },
  {
    address: CLI_WALLET,
    isPrimary: false,
    source: 'cli',
    linkedAt: null,
    indexingPending: false,
    network: 'testnet',
  },
];

const contract = {
  address: CONTRACT,
  deployer: CLI_WALLET,
  deployedAt: '2026-09-20T12:00:00.000Z',
  deployTxHash: '0'.repeat(64),
  network: 'testnet',
  wasmHash: null,
  contractType: 'wasm',
};

/** A fake SDK: alice deployed CONTRACT from her CLI-linked wallet. */
function fake(overrides: Partial<Signet> = {}): Signet {
  return {
    getProfile: async (h) => (h === 'alice' ? profile : null),
    getWallets: async () => wallets as never,
    listContracts: async () =>
      ({
        data: [contract],
        meta: { nextCursor: null, total: 1, truncated: false, cap: null, source: 'database' },
      }) as never,
    verifyDeployment: async (_h, address) =>
      address === CONTRACT
        ? { verified: true, attribution: { method: 'indexer', wallet: CLI_WALLET } }
        : { verified: false },
    ...overrides,
  } as Signet;
}

test('verified: the attribution, the wallets and the contracts', async () => {
  const res = await verifyApplicant(fake(), 'alice', CONTRACT);
  assert.equal(res.kind, 'verified');
  if (res.kind !== 'verified') return;
  assert.deepEqual(res.attribution, { method: 'indexer', wallet: CLI_WALLET });
  assert.equal(res.wallets.length, 2);
  assert.deepEqual(
    res.contracts.map((c) => c.address),
    [CONTRACT],
  );
  assert.equal(res.contractsTruncated, false);
});

test('not attributed: the profile is shown, the verdict is no', async () => {
  const res = await verifyApplicant(fake(), 'alice', OTHER);
  assert.equal(res.kind, 'not-attributed');
});

test('unavailable is its own answer, never "not verified"', async () => {
  const res = await verifyApplicant(
    fake({
      verifyDeployment: async () => {
        throw new UnavailableError('Contract attribution is unavailable.', { code: 'unavailable' });
      },
    }),
    'alice',
    CONTRACT,
  );
  assert.deepEqual(res, { kind: 'unavailable', message: 'Contract attribution is unavailable.' });
});

test('each other SDK error is a visible state', async () => {
  const throwing = (err: Error): Signet =>
    fake({
      getProfile: async () => {
        throw err;
      },
    });
  assert.deepEqual(
    await verifyApplicant(
      throwing(new RateLimitedError('slow', { retryAfterSeconds: 30 })),
      'alice',
      CONTRACT,
    ),
    { kind: 'rate-limited', retryAfterSeconds: 30 },
  );
  assert.deepEqual(
    await verifyApplicant(
      throwing(new ValidationError('Invalid handle', { parameter: 'handle' })),
      'x',
      CONTRACT,
    ),
    { kind: 'invalid', parameter: 'handle', message: 'Invalid handle' },
  );
  assert.equal(
    (await verifyApplicant(throwing(new NetworkError('offline')), 'alice', CONTRACT)).kind,
    'network',
  );
  assert.deepEqual(await verifyApplicant(fake(), 'nobody', CONTRACT), { kind: 'no-profile' });
  await assert.rejects(
    verifyApplicant(throwing(new NotFoundError()), 'alice', CONTRACT),
    NotFoundError,
  );
});

// ── The page, through the real server ────────────────────────────────────────

async function page(signet: Signet, query: string) {
  const server = createServer(handler(signet, 'https://signet.example'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/verify?${query}`);
    return {
      status: res.status,
      csp: res.headers.get('content-security-policy'),
      html: await res.text(),
    };
  } finally {
    server.close();
  }
}

test('the verified page names the deployer and shows the badge', async () => {
  const { status, csp, html } = await page(fake(), `handle=Alice&address=${CONTRACT}`);
  assert.equal(status, 200);
  assert.match(html, /Verified: @alice deployed this contract/);
  assert.match(html, new RegExp(`Deployed by</dt><dd><code>${CLI_WALLET}`));
  assert.match(
    html,
    new RegExp(`src="https://signet.example/api/v1/badge/alice.svg\\?contract=${CONTRACT}"`),
  );
  assert.match(csp ?? '', /img-src https:\/\/signet\.example/);
  assert.doesNotMatch(html, /<script/);
});

test('the not-attributed and unavailable pages say different things', async () => {
  const no = await page(fake(), `handle=alice&address=${OTHER}`);
  assert.match(no.html, /Not verified: @alice did not deploy this contract/);
  const down = await page(
    fake({
      verifyDeployment: async () => {
        throw new UnavailableError('down');
      },
    }),
    `handle=alice&address=${CONTRACT}`,
  );
  assert.match(down.html, /Signet could not check this right now/);
  assert.match(down.html, /This is not a verdict/);
  assert.doesNotMatch(down.html, /Not verified/);
});

test('what an applicant typed is escaped', async () => {
  const { html } = await page(
    fake(),
    `handle=${encodeURIComponent('<img src=x onerror=alert(1)>')}&address=x`,
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
