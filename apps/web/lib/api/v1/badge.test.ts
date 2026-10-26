import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import type { Attribution } from '../../contract-attribution.ts';
import type { ProfileContractsResult } from '../../profile-contracts.ts';
import type { Profile } from '../../profiles.ts';
import {
  BADGE_CACHE_CONTROL,
  badgeHandler,
  escapeXml,
  getBadgeContent,
  handleFromFile,
  renderBadge,
  type BadgeHandlerDeps,
  type BadgeStyle,
} from './badge.ts';

// UPDATE_BADGES=1 rewrites the fixtures from what the code renders now.
const FIXTURES = new URL('./testdata/badge/', import.meta.url);
const WALLET = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const OTHER = 'CA3D5KRYMCMCZVACBBQINPBVYQ4WY2OA36IC3PIGGEJNVMGT4DXFV3A6';

const alice: Profile = {
  name: 'alice',
  wallet: WALLET,
  bio: '',
  joined: '2026-01-01',
  source: 'database',
};
const contracts = (n: number, truncated = false): ProfileContractsResult => ({
  contracts: Array.from({ length: n }, () => ({}) as ProfileContractsResult['contracts'][number]),
  source: truncated ? 'horizon' : 'database',
  truncated,
  cap: truncated ? 200 : null,
  multiWallet: false,
});

/** alice is bound with 3 contracts and deployed CONTRACT; nobody else exists. */
const deps: BadgeHandlerDeps = {
  network: 'testnet',
  getProfile: async (h) => (h === 'alice' ? alice : null),
  resolveHandle: async () => ({ status: 'unbound' }),
  getProfileContracts: async () => contracts(3),
  attribute: async (_h, address): Promise<Attribution> =>
    address === CONTRACT
      ? {
          status: 'attributed',
          source: 'database',
          contract: {
            address,
            network: 'testnet',
            deployerPubkey: WALLET,
            deployTxHash: 'tx',
            deployedAt: '2026-09-20T12:00:00.000Z',
            wasmHash: null,
          },
        }
      : { status: 'not-attributed' },
  rateLimit: async () => ({ ok: true }),
};

async function get(path: string, d: BadgeHandlerDeps = deps, headers: Record<string, string> = {}) {
  const url = new URL(path, 'http://localhost');
  const file = url.pathname.split('/').pop()!;
  const res = await badgeHandler(d)(new Request(url, { headers }), {
    params: Promise.resolve({ file }),
  });
  return { res, body: await res.text() };
}

function fixture(name: string, svg: string) {
  const file = new URL(`${name}.svg`, FIXTURES);
  if (process.env.UPDATE_BADGES) writeFileSync(file, svg);
  assert.equal(svg, readFileSync(file, 'utf8'), `${name}.svg differs; UPDATE_BADGES=1 to accept`);
}

const STATES: Array<[string, string, BadgeHandlerDeps?]> = [
  ['verified', '/api/v1/badge/alice.svg'],
  [
    'verified-lower-bound',
    '/api/v1/badge/alice.svg',
    { ...deps, getProfileContracts: async () => contracts(200, true) },
  ],
  ['verified-contract', `/api/v1/badge/alice.svg?contract=${CONTRACT}`],
  ['not-verified', `/api/v1/badge/alice.svg?contract=${OTHER}`],
  ['not-found', '/api/v1/badge/nobody.svg'],
  [
    'unavailable',
    '/api/v1/badge/nobody.svg',
    { ...deps, resolveHandle: async () => ({ status: 'error' }) },
  ],
  ['verified-mainnet', '/api/v1/badge/alice.svg', { ...deps, network: 'mainnet' }],
];

for (const [name, path, d] of STATES) {
  for (const style of ['flat', 'plain'] as BadgeStyle[]) {
    test(`the ${name} badge (${style}) matches its fixture`, async () => {
      const sep = path.includes('?') ? '&' : '?';
      const { res, body } = await get(style === 'plain' ? `${path}${sep}style=plain` : path, d);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Content-Type'), 'image/svg+xml; charset=utf-8');
      assert.equal(
        res.headers.get('X-Signet-Badge-State'),
        name.replace(/-(lower-bound|contract|mainnet)$/, ''),
      );
      assert.match(body, /<title>[^<]+<\/title>/);
      assert.doesNotMatch(body, /<image|href=|@import|url\((?!#)/, 'nothing is fetched');
      fixture(style === 'plain' ? `${name}.plain` : name, body);
    });
  }
}

test('the text says what each state asserts', async () => {
  const text = async (path: string, d: BadgeHandlerDeps = deps) =>
    [...(await get(path, d)).body.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(await text('/api/v1/badge/alice.svg'), [
    'Signet',
    '@alice · 3 contracts',
    'TESTNET',
  ]);
  assert.deepEqual(
    await text('/api/v1/badge/alice.svg', {
      ...deps,
      getProfileContracts: async () => contracts(200, true),
    }),
    ['Signet', '@alice · 200+ contracts', 'TESTNET'],
  );
  assert.deepEqual(
    await text('/api/v1/badge/alice.svg', {
      ...deps,
      getProfileContracts: async () => contracts(1),
    }),
    ['Signet', '@alice · 1 contract', 'TESTNET'],
  );
  // No layer could list contracts: no number rather than a wrong one.
  assert.deepEqual(
    await text('/api/v1/badge/alice.svg', {
      ...deps,
      getProfileContracts: async () => ({ ...contracts(0), source: 'none', truncated: true }),
    }),
    ['Signet', '@alice', 'TESTNET'],
  );
  assert.deepEqual(await text(`/api/v1/badge/alice.svg?contract=${CONTRACT}`), [
    'Signet',
    '@alice · deployed CAMY…EUXZ',
    'TESTNET',
  ]);
});

test('?contract= with an unattributed contract never renders verified', async () => {
  for (const contract of [OTHER, 'not-a-contract', '', `${CONTRACT}<script>`]) {
    const { res, body } = await get(
      `/api/v1/badge/alice.svg?contract=${encodeURIComponent(contract)}`,
    );
    assert.equal(res.headers.get('X-Signet-Badge-State'), 'not-verified', contract);
    assert.doesNotMatch(body, /deployed/);
    assert.doesNotMatch(body, /<script/);
  }
  // A lookup that failed is grey, not "verified" and not "not verified".
  const down = await get(`/api/v1/badge/alice.svg?contract=${CONTRACT}`, {
    ...deps,
    attribute: async () => ({ status: 'unavailable' }),
  });
  assert.equal(down.res.headers.get('X-Signet-Badge-State'), 'unavailable');
});

test('a handle cannot inject markup', async () => {
  for (const evil of [
    '<script>alert(1)</script>',
    '"><svg onload=alert(1)>',
    "alice' onmouseover='x",
    'alice&lt;b&gt;',
  ]) {
    const { res, body } = await get(`/api/v1/badge/${encodeURIComponent(evil)}.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Signet-Badge-State'), 'not-found');
    // An invalid handle is never echoed at all.
    assert.equal(body.includes('alert'), false, evil);
    assert.equal(body.includes('onmouseover'), false, evil);
    assert.equal((body.match(/<svg/g) ?? []).length, 1);
  }
  // Escaping holds even for text the handle rules would never let through.
  const svg = renderBadge({
    state: 'verified',
    message: '<a href="x">&\'',
    network: 'testnet',
    title: '"</title><script>',
  });
  assert.equal(svg.includes('<a '), false);
  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /&lt;a href=&quot;x&quot;&gt;&amp;&apos;/);
  assert.equal(escapeXml(`<>&"'`), '&lt;&gt;&amp;&quot;&apos;');
});

test('caching: a verdict for 5 minutes with an ETag; unavailable is not cached', async () => {
  const { res } = await get('/api/v1/badge/alice.svg');
  assert.equal(res.headers.get('Cache-Control'), BADGE_CACHE_CONTROL);
  assert.equal(BADGE_CACHE_CONTROL, 'public, max-age=300');
  const etag = res.headers.get('ETag')!;
  assert.match(etag, /^W\/"[0-9a-f]{40}"$/);
  const again = await get('/api/v1/badge/alice.svg', deps, { 'If-None-Match': etag });
  assert.equal(again.res.status, 304);

  const grey = await get('/api/v1/badge/nobody.svg', {
    ...deps,
    resolveHandle: async () => ({ status: 'error' }),
  });
  assert.equal(grey.res.headers.get('Cache-Control'), 'no-store');
});

test('over the rate limit is still a 200 image, grey and uncached', async () => {
  const { res, body } = await get('/api/v1/badge/alice.svg', {
    ...deps,
    rateLimit: async () => ({ ok: false }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Signet-Badge-State'), 'unavailable');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(body, /status unavailable/);
});

test('an archived binding or a failing profile read is unavailable, never verified', async () => {
  for (const d of [
    { ...deps, getProfile: async () => ({ ...alice, archived: true }) },
    {
      ...deps,
      getProfile: async (): Promise<Profile | null> => {
        throw new Error('db down');
      },
    },
  ]) {
    const content = await getBadgeContent('alice', {}, d);
    assert.equal(content.state, 'unavailable');
  }
});

test('the path is {handle}.svg', () => {
  assert.equal(handleFromFile('alice.svg'), 'alice');
  assert.equal(handleFromFile('Alice.SVG'), 'Alice');
  assert.equal(handleFromFile('alice'), null);
  assert.equal(handleFromFile('alice.png'), null);
});
