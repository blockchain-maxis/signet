import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { WalletLookupResult } from '../../server/registry-read.ts';
import {
  LOOKUP_CACHE_CONTROL,
  lookupHandler,
  whoamiDeprecation,
  type LookupDeps,
  type LookupWalletRow,
} from './lookup.ts';
import { expectMatchesSchema } from './test-utils.ts';

const PRIMARY = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const CLI = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const UNKNOWN = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';

/** alice's two wallets: the on-chain primary, and one linked from the terminal. */
const rows: Record<string, LookupWalletRow> = {
  [PRIMARY]: { isPrimary: true, source: 'onchain', profile: { handle: 'alice' } },
  [CLI]: { isPrimary: false, source: 'cli', profile: { handle: 'alice' } },
};
const db = async (address: string) => rows[address] ?? null;
/** The registry knows only the primary binding. */
const registry = async (address: string): Promise<WalletLookupResult> =>
  address === PRIMARY ? { status: 'bound', handle: 'alice' } : { status: 'unbound' };

async function get(address: string, deps: LookupDeps) {
  const res = await lookupHandler({ network: 'testnet', ...deps })(
    new Request(`http://localhost/api/v1/lookup/${address}`),
    { params: Promise.resolve({ address }) },
  );
  return { res, body: await res.clone().json() };
}

test('a wallet linked from the terminal is found with source cli', async () => {
  const { res, body } = await get(CLI, { findWallet: db, lookupWallet: registry });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), LOOKUP_CACHE_CONTROL);
  assert.deepEqual(body, {
    data: { address: CLI, handle: 'alice', source: 'cli', isPrimary: false, network: 'testnet' },
    meta: { source: 'database' },
  });
  await expectMatchesSchema(res, 'lookupWallet', 200);
});

test('a primary wallet is onchain, from the database or the registry alone', async () => {
  const want = {
    address: PRIMARY,
    handle: 'alice',
    source: 'onchain',
    isPrimary: true,
    network: 'testnet',
  };
  const fromDb = await get(PRIMARY, { findWallet: db, lookupWallet: registry });
  assert.deepEqual(fromDb.body, { data: want, meta: { source: 'database' } });
  const noDb = await get(PRIMARY, { findWallet: async () => undefined, lookupWallet: registry });
  assert.deepEqual(noDb.body, { data: want, meta: { source: 'chain' } });
  await expectMatchesSchema(noDb.res, 'lookupWallet', 200);
});

test('an unknown address is a 200 with handle null', async () => {
  const { res, body } = await get(UNKNOWN, { findWallet: db, lookupWallet: registry });
  assert.equal(res.status, 200);
  assert.deepEqual(body.data, {
    address: UNKNOWN,
    handle: null,
    source: null,
    isPrimary: false,
    network: 'testnet',
  });
  await expectMatchesSchema(res, 'lookupWallet', 200);
  // With no registry configured, the database's miss is the answer.
  const dbOnly = await get(UNKNOWN, {
    findWallet: db,
    lookupWallet: async () => ({ status: 'unconfigured' }),
  });
  assert.equal(dbOnly.body.data.handle, null);
  assert.deepEqual(dbOnly.body.meta, { source: 'database' });
});

test('a C… address is a 400 pointing to the contract endpoints', async () => {
  const { res, body } = await get(CONTRACT, { findWallet: db, lookupWallet: registry });
  assert.equal(res.status, 400);
  assert.match(body.error.message, /\/api\/v1\/profiles\/\{handle\}\/contracts\/\{address\}/);
  await expectMatchesSchema(res, 'lookupWallet', 400);
  const junk = await get('nope', { findWallet: db, lookupWallet: registry });
  assert.equal(junk.res.status, 400);
});

test('with the database down and the registry up, the registry answers', async () => {
  const down = async (): Promise<LookupWalletRow | null> => {
    throw new Error('connection refused');
  };
  const { res, body } = await get(PRIMARY, { findWallet: down, lookupWallet: registry });
  assert.equal(res.status, 200);
  assert.equal(body.data.handle, 'alice');
  assert.deepEqual(body.meta, { source: 'chain' });
});

test('with no layer able to answer, a 503, not a null that reads as not linked', async () => {
  for (const findWallet of [async () => undefined, db]) {
    const { res } = await get(UNKNOWN, {
      findWallet,
      lookupWallet: async () => ({ status: 'error' }),
    });
    assert.equal(res.status, 503);
    await expectMatchesSchema(res, 'lookupWallet', 503);
  }
  const { res } = await get(UNKNOWN, {
    findWallet: async () => undefined,
    lookupWallet: async () => ({ status: 'unconfigured' }),
  });
  assert.equal(res.status, 503);
});

test('the old /api/cli/whoami names this route in Deprecation', () => {
  assert.deepEqual(whoamiDeprecation(CLI), {
    Deprecation: `/api/v1/lookup/${CLI}`,
    Link: `</api/v1/lookup/${CLI}>; rel="successor-version"`,
  });
  // The route sends them on its answer and on its 400.
  const route = readFileSync(
    new URL('../../../app/api/cli/whoami/route.ts', import.meta.url),
    'utf8',
  );
  assert.match(route, /headers: whoamiDeprecation\(null\)/);
  assert.match(route, /\.\.\.whoamiDeprecation\(publicKey\)/);
});
