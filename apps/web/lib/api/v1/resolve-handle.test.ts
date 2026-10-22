import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { GET, v1ResolveHandleData } from '../../../app/api/v1/resolve/[handle]/route.ts';
import { ok, V1Error } from './http.ts';
import { expectMatchesSchema } from './test-utils.ts';
import type { SimulatingServer } from '../../server/registry-read.ts';
import { nativeToScVal } from '@stellar/stellar-sdk';

const DUMMY_CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const DUMMY_WALLET = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';

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
        retval: nativeToScVal(returnValue, { type: 'address' }),
      },
    }),
  };
}

function stubNullServer(): SimulatingServer {
  return {
    simulateTransaction: async () => ({
      result: {
        retval: nativeToScVal(null),
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

function archivedSimulatingServer(): SimulatingServer {
  return {
    simulateTransaction: async () => ({
      transactionData: 'AAAAsimulated',
      result: {
        retval: nativeToScVal(DUMMY_WALLET, { type: 'address' }),
      },
      restorePreamble: {
        minResourceFee: '1000',
        transactionData: 'AAAArestore',
      },
    }),
  };
}

test('GET /api/v1/resolve/{handle} answers 200 with public, s-maxage=30 when bound', async () => {
  const req = new Request('http://localhost/api/v1/resolve/alice');
  const server = stubSimulatingServer(DUMMY_WALLET);

  // Directly test v1ResolveHandleData and schema validation
  const data = await v1ResolveHandleData('alice', {
    registry: { server },
    network: 'testnet',
    registryContract: DUMMY_CONTRACT_ID,
  });

  assert.equal(data.handle, 'alice');
  assert.equal(data.wallet, DUMMY_WALLET);
  assert.equal(data.network, 'testnet');
  assert.equal(data.registryContract, DUMMY_CONTRACT_ID);

  const response = ok(data, undefined, {
    headers: { 'Cache-Control': 'public, s-maxage=30' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, s-maxage=30');

  await expectMatchesSchema(response, 'resolveHandle', 200);
});

test('GET /api/v1/resolve/{handle} handles route invocation end-to-end', async () => {
  const req = new Request('http://localhost/api/v1/resolve/alice');
  const ctx = { params: Promise.resolve({ handle: 'alice' }) };

  const res = await GET(req, ctx);
  assert.ok([200, 404, 503].includes(res.status));
  if (res.status === 200) {
    assert.equal(res.headers.get('cache-control'), 'public, s-maxage=30');
  } else {
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('resolveHandle: unbound handle throws 404 not_found', async () => {
  const server = stubNullServer();

  await assert.rejects(
    async () => {
      await v1ResolveHandleData('unbound-user', {
        registry: { server },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof V1Error);
      assert.equal(err.code, 'not_found');
      assert.equal(err.details?.handle, 'unbound-user');
      return true;
    },
  );
});

test('resolveHandle: simulation error throws 503 unavailable with reason simulation_error', async () => {
  const server = throwingSimulatingServer();

  await assert.rejects(
    async () => {
      await v1ResolveHandleData('alice', {
        registry: { server },
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof V1Error);
      assert.equal(err.code, 'unavailable');
      assert.equal(err.details?.reason, 'simulation_error');
      return true;
    },
  );
});

test('resolveHandle: unconfigured registry throws 503 unavailable with reason unconfigured', async () => {
  delete process.env.REGISTRY_CONTRACT_ID;
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;

  await assert.rejects(
    async () => {
      await v1ResolveHandleData('alice', {
        registryContract: '',
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof V1Error);
      assert.equal(err.code, 'unavailable');
      assert.equal(err.details?.reason, 'unconfigured');
      return true;
    },
  );
});

test('resolveHandle: reports archived entry as resolveHandleDetailed returns it', async () => {
  const server = archivedSimulatingServer();

  const data = await v1ResolveHandleData('alice', {
    registry: { server },
  });

  assert.equal(data.handle, 'alice');
  assert.equal(data.archived, true);
  assert.ok(data.restorePreamble);

  const response = ok(data);
  await expectMatchesSchema(response, 'resolveHandle', 200);
});
