import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { GET, v1RegistryStatsData } from '../../../app/api/v1/registry/stats/route.ts';
import { ok } from './http.ts';
import { expectMatchesSchema } from './test-utils.ts';
import type { SimulatingServer } from '../../server/registry-read.ts';
import { nativeToScVal } from '@stellar/stellar-sdk';

const DUMMY_CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

beforeEach(() => {
  process.env.REGISTRY_CONTRACT_ID = DUMMY_CONTRACT_ID;
});

afterEach(() => {
  delete process.env.REGISTRY_CONTRACT_ID;
});

function stubSimulatingServer(returnValue: unknown): SimulatingServer {
  return {
    simulateTransaction: async () => ({
      result: {
        retval: nativeToScVal(returnValue, { type: 'u32' }),
      },
    }),
  };
}

function throwingSimulatingServer(): SimulatingServer {
  return {
    simulateTransaction: async () => {
      throw new Error('RPC endpoint unreachable');
    },
  };
}

test('GET /api/v1/registry/stats answers with HTTP 200, public cache-control, and matches schema', async () => {
  const req = new Request('http://localhost/api/v1/registry/stats');
  const response = await GET(req);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, s-maxage=300');

  await expectMatchesSchema(response, 'getRegistryStats', 200);

  const body = (await response.clone().json()) as {
    data: {
      network: string;
      registryContract: string;
      boundHandles: number | null;
      indexedWallets: number | null;
      indexedContracts: number | null;
    };
  };

  assert.ok(typeof body.data.network === 'string');
  assert.ok(typeof body.data.registryContract === 'string');
});

test('v1RegistryStatsData reports all counts when available', async () => {
  const mockDb = {
    wallet: {
      count: async () => 42,
    },
    contract: {
      count: async () => 17,
    },
  };

  const data = await v1RegistryStatsData({
    registry: { server: stubSimulatingServer(105) },
    db: mockDb,
    network: 'testnet',
    registryContract: 'CDUMMYREGISTRYCONTRACT',
  });

  assert.equal(data.network, 'testnet');
  assert.equal(data.registryContract, 'CDUMMYREGISTRYCONTRACT');
  assert.equal(data.boundHandles, 105);
  assert.equal(data.indexedWallets, 42);
  assert.equal(data.indexedContracts, 17);

  const response = ok(data);
  await expectMatchesSchema(response, 'getRegistryStats', 200);
});

test('v1RegistryStatsData reports boundHandles: null when registry simulation fails/unreadable', async () => {
  const mockDb = {
    wallet: { count: async () => 10 },
    contract: { count: async () => 5 },
  };

  const data = await v1RegistryStatsData({
    registry: { server: throwingSimulatingServer() },
    db: mockDb,
  });

  assert.equal(data.boundHandles, null);
  assert.equal(data.indexedWallets, 10);
  assert.equal(data.indexedContracts, 5);

  const response = ok(data);
  assert.equal(response.status, 200);
  await expectMatchesSchema(response, 'getRegistryStats', 200);
});

test('v1RegistryStatsData reports boundHandles: null when registry is unconfigured', async () => {
  delete process.env.REGISTRY_CONTRACT_ID;
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;

  const data = await v1RegistryStatsData({
    registryContract: '',
    db: null,
  });

  assert.equal(data.boundHandles, null);
  assert.equal(data.registryContract, '');
  assert.equal(data.indexedWallets, null);
  assert.equal(data.indexedContracts, null);

  const response = ok(data);
  assert.equal(response.status, 200);
  await expectMatchesSchema(response, 'getRegistryStats', 200);
});

test('v1RegistryStatsData reports indexed counts as null when database is not available', async () => {
  const data = await v1RegistryStatsData({
    registry: { server: stubSimulatingServer(20) },
    db: null,
  });

  assert.equal(data.boundHandles, 20);
  assert.equal(data.indexedWallets, null);
  assert.equal(data.indexedContracts, null);

  const response = ok(data);
  assert.equal(response.status, 200);
  await expectMatchesSchema(response, 'getRegistryStats', 200);
});

test('v1RegistryStatsData reports indexed counts as null when database query throws', async () => {
  const failingDb = {
    wallet: {
      count: async () => {
        throw new Error('Database connection failed');
      },
    },
    contract: {
      count: async () => {
        throw new Error('Database connection failed');
      },
    },
  };

  const data = await v1RegistryStatsData({
    registry: { server: stubSimulatingServer(5) },
    db: failingDb,
  });

  assert.equal(data.boundHandles, 5);
  assert.equal(data.indexedWallets, null);
  assert.equal(data.indexedContracts, null);

  const response = ok(data);
  assert.equal(response.status, 200);
  await expectMatchesSchema(response, 'getRegistryStats', 200);
});
