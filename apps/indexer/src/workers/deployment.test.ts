import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Horizon } from '@stellar/stellar-sdk';
import {
  runDeploymentWorker,
  type DeploymentStore,
  type DeploymentWallet,
  type ContractCreate,
} from './deployment.ts';

const CONFIG = { network: 'testnet' } as Parameters<typeof runDeploymentWorker>[1];

const WALLET_A: DeploymentWallet = {
  id: 'w1',
  pubkey: 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD',
  indexRequestedAt: null,
};

/** In-memory `DeploymentStore`. `wallets` is mutable so tests can inspect the indexRequestedAt writes. */
function memoryStore(wallets: DeploymentWallet[]): {
  store: DeploymentStore;
  contracts: Map<string, ContractCreate>;
  updateCalls: { count: number };
} {
  const contracts = new Map<string, ContractCreate>();
  const updateCalls = { count: 0 };
  const store: DeploymentStore = {
    wallet: {
      findMany: async () => wallets,
      update: async ({ where, data }) => {
        updateCalls.count++;
        const w = wallets.find((x) => x.id === where.id);
        if (!w) throw new Error(`no wallet ${where.id}`);
        w.indexRequestedAt = data.indexRequestedAt;
      },
    },
    contract: {
      findFirst: async ({ where }) => {
        const found = [...contracts.values()].find((c) => c.deployTxHash === where.deployTxHash);
        return found ? { id: found.address } : null;
      },
      upsert: async ({ create }) => {
        if (!contracts.has(create.address)) contracts.set(create.address, create);
      },
    },
  };
  return { store, contracts, updateCalls };
}

function paymentOp(txHash: string) {
  return { type: 'payment', transaction_hash: txHash };
}

function horizonReturning(records: unknown[]): Horizon.Server {
  return {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records }),
          }),
        }),
      }),
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;
}

// ─── indexRequestedAt clearing (#281) ───────────────────────────────────────

test('a pending index request is cleared after a successful scan', async () => {
  const wallets: DeploymentWallet[] = [{ ...WALLET_A, indexRequestedAt: new Date('2026-01-01') }];
  const { store } = memoryStore(wallets);

  await runDeploymentWorker(horizonReturning([paymentOp('h1')]), CONFIG, store);

  assert.equal(wallets[0]!.indexRequestedAt, null, 'the request is cleared once the wallet has been scanned');
});

test('a pending index request is cleared even when the scan itself fails', async () => {
  const wallets: DeploymentWallet[] = [{ ...WALLET_A, indexRequestedAt: new Date('2026-01-01') }];
  const { store } = memoryStore(wallets);
  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => {
              throw new Error('horizon exploded: status=500');
            },
          }),
        }),
      }),
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;

  await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(
    wallets[0]!.indexRequestedAt,
    null,
    'a failed scan still fulfills the request — otherwise a Horizon outage would keep forcing short ticks',
  );
});

test('a wallet with no pending index request is never written to', async () => {
  const wallets: DeploymentWallet[] = [{ ...WALLET_A, indexRequestedAt: null }];
  const { store, updateCalls } = memoryStore(wallets);

  await runDeploymentWorker(horizonReturning([paymentOp('h1')]), CONFIG, store);

  assert.equal(updateCalls.count, 0, 'no wasted write when there was nothing to clear');
});

// ─── Existing dedup / isolation behavior, unaffected by the above ───────────

test('an operation whose deployTxHash already has a contract is skipped without fetching the transaction', async () => {
  const wallets: DeploymentWallet[] = [{ ...WALLET_A }];
  const { store, contracts } = memoryStore(wallets);
  contracts.set('CEXISTING', {
    address: 'CEXISTING',
    walletId: WALLET_A.id,
    deployerPubkey: WALLET_A.pubkey,
    deployedAt: new Date('2026-01-01'),
    deployTxHash: 'hash-1',
    network: 'testnet',
  });

  let fetched = 0;
  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: [
                { type: 'invoke_host_function', function: 'HostFunctionTypeCreateContract', transaction_hash: 'hash-1' },
              ],
            }),
          }),
        }),
      }),
    }),
    transactions: () => ({
      transaction: () => {
        fetched++;
        return { call: async () => ({}) };
      },
    }),
  } as unknown as Horizon.Server;

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(fetched, 0, 'the transaction is never re-fetched');
  assert.equal(result.contractsFound, 0);
  assert.equal(contracts.size, 1);
});

test('non-create-contract operations are ignored', async () => {
  const wallets: DeploymentWallet[] = [{ ...WALLET_A }];
  const { store, contracts } = memoryStore(wallets);
  const horizon = horizonReturning([
    { type: 'payment', transaction_hash: 'hash-2' },
    { type: 'invoke_host_function', function: 'HostFunctionTypeInvokeContract', transaction_hash: 'hash-3' },
  ]);

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(result.contractsFound, 0);
  assert.equal(contracts.size, 0);
});

test('a Horizon failure on one wallet does not abort the others', async () => {
  const walletB: DeploymentWallet = { ...WALLET_A, id: 'w2', pubkey: 'GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ' };
  const wallets: DeploymentWallet[] = [{ ...WALLET_A }, walletB];
  const { store } = memoryStore(wallets);

  let call = 0;
  const scannedPubkeys: string[] = [];
  const horizon = {
    operations: () => ({
      forAccount: (pubkey: string) => {
        scannedPubkeys.push(pubkey);
        return {
          order: () => ({
            limit: () => ({
              call: async () => {
                if (call++ === 0) throw new Error('horizon exploded: status=400');
                return { records: [] };
              },
            }),
          }),
        };
      },
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(result.walletsScanned, 2);
  assert.deepEqual(scannedPubkeys, [WALLET_A.pubkey, walletB.pubkey]);
});
