import assert from 'node:assert/strict';
import test from 'node:test';
import { StrKey } from '@stellar/stellar-sdk';
import {
  attributeContractWithDeps,
  type AttributeContractDeps,
  type AttributionDb,
} from '../../contract-attribution.ts';
import {
  NOT_ATTRIBUTED_MESSAGE,
  PROFILE_CONTRACT_CACHE_CONTROL,
  profileContractHandler,
} from './profile-contract.ts';
import { expectMatchesSchema } from './test-utils.ts';

// The chain-confirmed create-contract vector of contract-attribution.test.ts:
// this deployer and salt produce this contract on testnet.
const DEPLOYER = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const SALT_HEX = '075afa7ea513abbddc97610bbef3276c89be0a040c3e914920dd7efb424a6ad6';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
/** Bob's contract. */
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 9));
/** A valid contract ID nobody deployed. */
const MISSING = StrKey.encodeContract(Buffer.alloc(32, 7));
const TX = 'ea7a9098e63e588d81bb3aeff8c09fe2d82767228ae99a04f3039de915e753a2';

/** The indexer: alice deployed CONTRACT, bob deployed OTHER. */
const db: AttributionDb = {
  findContract: async ({ address, handle }) => {
    const owned = { alice: CONTRACT, bob: OTHER }[handle];
    if (owned !== address) return null;
    return {
      address,
      network: 'testnet',
      deployerPubkey: DEPLOYER,
      deployTxHash: TX,
      deployedAt: new Date('2026-09-20T12:00:00.000Z'),
      wasmHash: 'ab'.repeat(32),
      walletId: 'w1',
      walletPubkey: DEPLOYER,
    };
  },
};

function get(handle: string, address: string, deps: AttributeContractDeps) {
  const route = profileContractHandler({
    attribute: (h, a) => attributeContractWithDeps(h, a, { network: 'testnet', ...deps }),
  });
  return route(new Request(`http://localhost/api/v1/profiles/${handle}/contracts/${address}`), {
    params: Promise.resolve({ handle, address }),
  });
}

test('a contract one of the handle wallets deployed is a 200, cached for 5 minutes', async () => {
  const res = await get('Alice', CONTRACT, { db });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), PROFILE_CONTRACT_CACHE_CONTROL);
  assert.equal(PROFILE_CONTRACT_CACHE_CONTROL, 'public, s-maxage=300');
  const body = await res.clone().json();
  assert.deepEqual(body, {
    data: {
      address: CONTRACT,
      handle: 'alice',
      deployer: DEPLOYER,
      deployedAt: '2026-09-20T12:00:00.000Z',
      network: 'testnet',
      wasmHash: 'ab'.repeat(32),
      attribution: { method: 'indexer', wallet: DEPLOYER },
    },
  });
  await expectMatchesSchema(res, 'getProfileContract', 200);
});

test("another handle's contract is the same 404 as one that does not exist", async () => {
  const theirs = await get('alice', OTHER, { db });
  const missing = await get('alice', MISSING, { db });
  const nobody = await get('nobody', OTHER, { db });
  for (const res of [theirs, missing, nobody]) assert.equal(res.status, 404);
  const body = await theirs.clone().text();
  assert.equal(await missing.clone().text(), body);
  // Nor does the 404 depend on whether the handle exists.
  assert.equal(await nobody.clone().text(), body);
  assert.deepEqual(JSON.parse(body), {
    error: { code: 'not_found', message: NOT_ATTRIBUTED_MESSAGE },
  });
  assert.equal(theirs.headers.get('Cache-Control'), missing.headers.get('Cache-Control'));
  await expectMatchesSchema(theirs, 'getProfileContract', 404);
});

test('an invalid contract ID or handle is a 400', async () => {
  for (const [handle, address] of [
    ['alice', 'not-a-contract'],
    ['alice', DEPLOYER],
    // Right shape, bad checksum.
    ['alice', `${CONTRACT.slice(0, -1)}A`],
    ['Not A Handle!', CONTRACT],
  ] as const) {
    const res = await get(handle, address, { db });
    assert.equal(res.status, 400, `${handle} ${address}`);
    await expectMatchesSchema(res, 'getProfileContract', 400);
  }
});

test('with no database, the deployer check over Horizon attributes it', async () => {
  const deps: AttributeContractDeps = {
    db: { findContract: async () => undefined },
    horizon: {
      listWallets: async (handle) => (handle === 'alice' ? [DEPLOYER] : []),
      listOperations: async () => ({
        operations: [
          {
            type: 'invoke_host_function',
            function: 'HostFunctionTypeCreateContract',
            salt: SALT_HEX,
            transactionHash: TX,
            createdAt: '2026-09-20T12:00:00Z',
          },
        ],
        truncated: false,
      }),
      getResultMetaXdr: async () => null,
    },
  };
  const res = await get('alice', CONTRACT, deps);
  assert.equal(res.status, 200);
  const { data } = await res.clone().json();
  assert.deepEqual(data.attribution, { method: 'deployer-check', wallet: DEPLOYER });
  assert.equal(data.wasmHash, null);
  assert.equal(data.deployedAt, '2026-09-20T12:00:00.000Z');
  await expectMatchesSchema(res, 'getProfileContract', 200);

  const other = await get('bob', CONTRACT, deps);
  assert.equal(other.status, 404);

  const down = await get('alice', CONTRACT, {
    ...deps,
    horizon: {
      ...deps.horizon!,
      listOperations: async () => {
        throw new Error('horizon down');
      },
    },
  });
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('Cache-Control'), 'no-store');
});
