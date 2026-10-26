import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignetClient } from './client.ts';
import { UnavailableError } from './errors.ts';

const BASE = 'https://signet.dev';
const WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const HASH = 'ab'.repeat(32);

/** A fetch that routes by path+query to a reply, recording every URL asked. */
function routes(table: Record<string, { status?: number; body: unknown }>) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    urls.push(u.pathname + u.search);
    const reply = table[u.pathname + u.search] ?? {
      status: 404,
      body: { error: { code: 'not_found', message: 'nope' } },
    };
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { client: new SignetClient({ baseUrl: BASE, fetch: fetchImpl, maxRetries: 0 }), urls };
}

const contract = (i: number) => ({
  address: `C${String.fromCharCode(65 + i).repeat(55)}`,
  deployer: WALLET,
  deployedAt: `2026-10-0${9 - i}T00:00:00.000Z`,
  deployTxHash: '0'.repeat(64),
  network: 'testnet',
  wasmHash: null,
  contractType: 'wasm',
});

const attributed = {
  address: CONTRACT,
  handle: 'alice',
  deployer: WALLET,
  deployedAt: '2026-09-20T12:00:00.000Z',
  network: 'testnet',
  wasmHash: HASH,
  attribution: { method: 'indexer', wallet: WALLET },
};

test('getWallets reads /profiles/{handle}/wallets', async () => {
  const wallets = [{ address: WALLET, isPrimary: true, source: 'onchain' }];
  const { client, urls } = routes({
    '/api/v1/profiles/alice/wallets': { body: { data: wallets, meta: { source: 'db' } } },
  });
  assert.deepEqual(await client.getWallets('alice'), wallets);
  assert.equal(await client.getWallets('ghost'), null);
  assert.deepEqual(urls, ['/api/v1/profiles/alice/wallets', '/api/v1/profiles/ghost/wallets']);
});

test('listContracts passes limit and cursor and returns data and meta', async () => {
  const meta = { nextCursor: 'abc', total: 3, truncated: false, cap: null, source: 'database' };
  const { client, urls } = routes({
    '/api/v1/profiles/alice/contracts?limit=1&cursor=prev': {
      body: { data: [contract(0)], meta },
    },
  });
  const page = await client.listContracts('alice', { limit: 1, cursor: 'prev' });
  assert.deepEqual(page, { data: [contract(0)], meta });
  assert.deepEqual(urls, ['/api/v1/profiles/alice/contracts?limit=1&cursor=prev']);
});

test('getContract is the contract when attributed, null on the 404', async () => {
  const { client, urls } = routes({
    [`/api/v1/profiles/alice/contracts/${CONTRACT}`]: { body: { data: attributed } },
  });
  assert.deepEqual(await client.getContract('alice', CONTRACT), attributed);
  assert.equal(await client.getContract('bob', CONTRACT), null);
  assert.equal(urls[1], `/api/v1/profiles/bob/contracts/${CONTRACT}`);
});

test('verifyDeployment answers verified with the attribution, or not', async () => {
  const { client } = routes({
    [`/api/v1/profiles/alice/contracts/${CONTRACT}`]: { body: { data: attributed } },
  });
  assert.deepEqual(await client.verifyDeployment('alice', CONTRACT), {
    verified: true,
    attribution: { method: 'indexer', wallet: WALLET },
  });
  assert.deepEqual(await client.verifyDeployment('bob', CONTRACT), { verified: false });
});

test('verifyDeployment throws when the deployment could not check', async () => {
  const { client } = routes({
    [`/api/v1/profiles/alice/contracts/${CONTRACT}`]: {
      status: 503,
      body: { error: { code: 'unavailable', message: 'Contract attribution is unavailable.' } },
    },
  });
  await assert.rejects(client.verifyDeployment('alice', CONTRACT), UnavailableError);
});

test('getContractSpec and getSpecByHash read the spec routes, null on 404', async () => {
  const spec = { schemaVersion: 1, functions: [] };
  const { client, urls } = routes({
    [`/api/v1/contracts/${CONTRACT}/spec`]: {
      body: {
        data: {
          address: CONTRACT,
          network: 'testnet',
          wasmHash: HASH,
          spec,
          specSource: 'embedded',
        },
      },
    },
    [`/api/v1/specs/${HASH}`]: {
      body: { data: { network: 'testnet', wasmHash: HASH, spec, specSource: 'embedded' } },
    },
  });
  assert.equal((await client.getContractSpec(CONTRACT))?.wasmHash, HASH);
  assert.deepEqual((await client.getSpecByHash(HASH))?.spec, spec);
  assert.equal(await client.getSpecByHash('cd'.repeat(32)), null);
  assert.deepEqual(urls.slice(0, 2), [
    `/api/v1/contracts/${CONTRACT}/spec`,
    `/api/v1/specs/${HASH}`,
  ]);
});

test('listOperations reads /profiles/{handle}/operations', async () => {
  const meta = { nextCursor: null, total: 1, truncated: false, cap: null, source: 'database' };
  const op = { id: 'op-1', type: 'invoke_host_function' };
  const { client, urls } = routes({
    '/api/v1/profiles/alice/operations?limit=5': { body: { data: [op], meta } },
  });
  assert.deepEqual(await client.listOperations('alice', { limit: 5 }), { data: [op], meta });
  assert.deepEqual(urls, ['/api/v1/profiles/alice/operations?limit=5']);
});

test('lookupAddress returns the whole lookup', async () => {
  const data = {
    address: WALLET,
    handle: 'alice',
    source: 'cli',
    isPrimary: false,
    network: 'testnet',
  };
  const { client } = routes({
    [`/api/v1/lookup/${WALLET}`]: { body: { data, meta: { source: 'database' } } },
  });
  assert.deepEqual(await client.lookupAddress(WALLET), data);
});

test('getRegistryStats and getHealth return their data', async () => {
  const stats = { boundHandles: 4, indexedContracts: 9, indexedWallets: 5, network: 'testnet' };
  const health = { status: 'ok', apiVersion: '1' };
  const { client, urls } = routes({
    '/api/v1/registry/stats': { body: { data: stats } },
    '/api/v1/health': { body: { data: health } },
  });
  assert.deepEqual(await client.getRegistryStats(), stats);
  assert.deepEqual(await client.getHealth(), health);
  assert.deepEqual(urls, ['/api/v1/registry/stats', '/api/v1/health']);
});

// ── Iteration ───────────────────────────────────────────────────────────────

const page = (items: number[], nextCursor: string | null, truncated = false) => ({
  body: {
    data: items.map(contract),
    meta: {
      nextCursor,
      total: truncated ? null : 5,
      truncated,
      cap: truncated ? 3 : null,
      source: 'database',
    },
  },
});

test('iterateContracts follows nextCursor across three pages', async () => {
  const { client, urls } = routes({
    '/api/v1/profiles/alice/contracts?limit=2': page([0, 1], 'p2'),
    '/api/v1/profiles/alice/contracts?limit=2&cursor=p2': page([2, 3], 'p3'),
    '/api/v1/profiles/alice/contracts?limit=2&cursor=p3': page([4], null),
  });
  const it = client.iterateContracts('alice', { pageSize: 2 });
  const seen: string[] = [];
  for await (const c of it) seen.push(c.address);
  assert.deepEqual(
    seen,
    [0, 1, 2, 3, 4].map((i) => contract(i).address),
  );
  assert.equal(it.truncated, false);
  assert.equal(urls.length, 3);
});

test('a truncated stream ends early and says so', async () => {
  const { client } = routes({
    '/api/v1/profiles/alice/operations': {
      body: {
        data: [{ id: 'a' }, { id: 'b' }],
        meta: { nextCursor: 'more', total: null, truncated: true, cap: 3, source: 'horizon' },
      },
    },
    '/api/v1/profiles/alice/operations?cursor=more': {
      body: {
        data: [{ id: 'c' }],
        meta: { nextCursor: null, total: null, truncated: true, cap: 3, source: 'horizon' },
      },
    },
  });
  const it = client.iterateOperations('alice');
  assert.equal(it.truncated, null, 'unknown until the iteration is done');
  const ids: string[] = [];
  let result = await it.next();
  while (!result.done) {
    ids.push(result.value.id);
    result = await it.next();
  }
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.deepEqual(result.value, { truncated: true });
  assert.equal(it.truncated, true);
});

test('an empty list iterates nothing, not truncated', async () => {
  const { client } = routes({ '/api/v1/profiles/alice/contracts': page([], null) });
  const it = client.iterateContracts('alice');
  let n = 0;
  for await (const _ of it) n++;
  assert.equal(n, 0);
  assert.equal(it.truncated, false);
});
