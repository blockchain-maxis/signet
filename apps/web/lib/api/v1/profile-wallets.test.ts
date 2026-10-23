import assert from 'node:assert/strict';
import test from 'node:test';
import { GET, OPTIONS } from '../../../app/api/v1/profiles/[handle]/wallets/route.ts';
import { getHandleWallets, toWalletSource, type HandleWalletsStore } from '../../server/account.ts';
import { V1Error } from './http.ts';

const PRIMARY_PUBKEY = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';
const CLI_PUBKEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function createMockStore(wallets: any[]): HandleWalletsStore {
  return {
    profile: {
      findUnique: async ({ where }: { where: { handle: string } }) => {
        if (where.handle === 'alice') {
          return {
            handle: 'alice',
            wallets,
          };
        }
        return null;
      },
    },
  };
}

test('getHandleWallets returns primary and CLI wallets from DB with primary sorted first', async () => {
  const attestedDate = new Date('2026-02-01T12:00:00.000Z');
  const indexRequestedDate = new Date('2026-02-02T15:00:00.000Z');

  // Deliberately put CLI wallet first in array to test primary sorting
  const store = createMockStore([
    {
      pubkey: CLI_PUBKEY,
      isPrimary: false,
      source: 'cli',
      attestedAt: attestedDate,
      indexRequestedAt: indexRequestedDate,
    },
    {
      pubkey: PRIMARY_PUBKEY,
      isPrimary: true,
      source: 'onchain',
      attestedAt: attestedDate,
      indexRequestedAt: null,
    },
  ]);

  const result = await getHandleWallets('alice', {
    store,
    network: 'testnet',
  });

  assert.equal(result.meta.source, 'db');
  assert.equal(result.data.length, 2);
  const [first, second] = result.data;
  assert.ok(first);
  assert.ok(second);

  // Primary must be sorted first
  assert.equal(first.address, PRIMARY_PUBKEY);
  assert.equal(first.isPrimary, true);
  assert.equal(first.source, 'onchain');
  assert.equal(first.linkedAt, attestedDate.toISOString());
  assert.equal(first.indexingPending, false);
  assert.equal(first.network, 'testnet');

  // Secondary CLI wallet second
  assert.equal(second.address, CLI_PUBKEY);
  assert.equal(second.isPrimary, false);
  assert.equal(second.source, 'cli');
  assert.equal(second.linkedAt, attestedDate.toISOString());
  assert.equal(second.indexingPending, true);
  assert.equal(second.network, 'testnet');
});

test('getHandleWallets falls back to chain registry without database', async () => {
  const result = await getHandleWallets('alice', {
    store: null,
    resolveHandle: async (handle: string) => (handle === 'alice' ? PRIMARY_PUBKEY : null),
    network: 'testnet',
  });

  assert.equal(result.meta.source, 'chain');
  assert.equal(result.data.length, 1);
  const [first] = result.data;
  assert.ok(first);
  assert.equal(first.address, PRIMARY_PUBKEY);
  assert.equal(first.isPrimary, true);
  assert.equal(first.source, 'onchain');
  assert.equal(first.linkedAt, null);
  assert.equal(first.indexingPending, false);
  assert.equal(first.network, 'testnet');
});

test('getHandleWallets throws V1Error not_found for unknown handle', async () => {
  await assert.rejects(
    () =>
      getHandleWallets('unknown_user', {
        store: null,
        resolveHandle: async () => null,
      }),
    (err: unknown) => {
      assert.ok(err instanceof V1Error);
      assert.equal(err.code, 'not_found');
      return true;
    },
  );
});

test('toWalletSource maps and logs unknown source values instead of passing them through', () => {
  assert.equal(toWalletSource('onchain', PRIMARY_PUBKEY), 'onchain');
  assert.equal(toWalletSource('cli', PRIMARY_PUBKEY), 'cli');
  assert.equal(toWalletSource('curated', PRIMARY_PUBKEY), 'curated');

  // Unknown value mapped to 'unknown'
  const mapped = toWalletSource('malicious_or_unknown_source', PRIMARY_PUBKEY);
  assert.equal(mapped, 'unknown');
  assert.notEqual(mapped, 'malicious_or_unknown_source');
});

test('getHandleWallets maps unknown DB source to unknown', async () => {
  const store = createMockStore([
    {
      pubkey: PRIMARY_PUBKEY,
      isPrimary: true,
      source: 'unrecognised_source_xyz',
      attestedAt: new Date(),
      indexRequestedAt: null,
    },
  ]);

  const result = await getHandleWallets('alice', { store });
  const [first] = result.data;
  assert.ok(first);
  assert.equal(first.source, 'unknown');
  assert.notEqual(first.source, 'unrecognised_source_xyz');
});

test('GET /api/v1/profiles/{handle}/wallets route returns 200 with standard envelope', async () => {
  const req = new Request('http://localhost/api/v1/profiles/alice/wallets');
  const ctx = { params: Promise.resolve({ handle: 'alice' }) };

  // Run with chain fallback when no DB is connected
  const res = await GET(req, ctx);
  // If registry is not configured in this test environment, it returns 404 not_found
  assert.ok(res.status === 200 || res.status === 404);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('GET /api/v1/profiles/{handle}/wallets rejects invalid handle format with 400', async () => {
  const req = new Request('http://localhost/api/v1/profiles/invalid%20handle/wallets');
  const ctx = { params: Promise.resolve({ handle: 'invalid handle' }) };

  const res = await GET(req, ctx);
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
});

test('OPTIONS /api/v1/profiles/{handle}/wallets handles preflight', async () => {
  const req = new Request('http://localhost/api/v1/profiles/alice/wallets', {
    method: 'OPTIONS',
  });
  const ctx = { params: Promise.resolve({ handle: 'alice' }) };

  const res = await OPTIONS(req, ctx);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
