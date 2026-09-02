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
};
const WALLET_B: DeploymentWallet = {
  id: 'w2',
  pubkey: 'GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ',
};

/** In-memory `DeploymentStore` keyed on contract address, mirroring the real unique constraint. */
function memoryStore(): { store: DeploymentStore; contracts: Map<string, ContractCreate> } {
  const contracts = new Map<string, ContractCreate>();
  const store: DeploymentStore = {
    wallet: { findMany: async () => [] },
    contract: {
      findFirst: async ({ where }) => {
        const found = [...contracts.values()].find((c) => c.deployTxHash === where.deployTxHash);
        return found ? { id: found.address } : null;
      },
      upsert: async ({ create }) => {
        contracts.set(create.address, create);
      },
    },
  };
  return { store, contracts };
}

function createContractOp(txHash: string) {
  return {
    type: 'invoke_host_function',
    function: 'HostFunctionTypeCreateContract',
    transaction_hash: txHash,
    paging_token: '4294967296000', // ledger 1
  };
}

/**
 * A Horizon stub that records which pubkeys were scanned (via `forAccount`)
 * and which transaction hashes were fetched (via `transactions().transaction`).
 * `recordsFor` lets each test control what operations come back per wallet.
 */
function trackingHorizon(recordsFor: (pubkey: string) => unknown[]) {
  const scannedPubkeys: string[] = [];
  const fetchedTxHashes: string[] = [];
  const horizon = {
    operations: () => ({
      forAccount: (pubkey: string) => {
        scannedPubkeys.push(pubkey);
        return {
          order: () => ({
            limit: () => ({
              call: async () => ({ records: recordsFor(pubkey) }),
            }),
          }),
        };
      },
    }),
    transactions: () => ({
      transaction: (txHash: string) => {
        fetchedTxHashes.push(txHash);
        return {
          call: async () => ({
            result_meta_xdr: '',
            ledger_attr: 2,
            created_at: '2026-01-01T00:00:00Z',
          }),
        };
      },
    }),
  } as unknown as Horizon.Server;
  return { horizon, scannedPubkeys, fetchedTxHashes };
}

test('a wallet linked between cycles is scanned on the next run, without a restart', async () => {
  const { store } = memoryStore();
  const wallets: DeploymentWallet[] = [WALLET_A];
  store.wallet.findMany = async () => wallets;
  const { horizon, scannedPubkeys } = trackingHorizon(() => []);

  const first = await runDeploymentWorker(horizon, CONFIG, store);
  assert.equal(first.walletsScanned, 1);
  assert.deepEqual(scannedPubkeys, [WALLET_A.pubkey]);

  // Simulate the attestation worker inserting a new Wallet row mid-life —
  // the store's backing list grows between calls, exactly as `findMany()`
  // against a real database would reflect a row added since the last tick.
  wallets.push(WALLET_B);

  const second = await runDeploymentWorker(horizon, CONFIG, store);
  assert.equal(second.walletsScanned, 2, 'the newly linked wallet is included without a restart');
  assert.deepEqual(scannedPubkeys, [WALLET_A.pubkey, WALLET_A.pubkey, WALLET_B.pubkey]);
});

test('an operation whose deployTxHash already has a contract is skipped without fetching the transaction', async () => {
  const { store, contracts } = memoryStore();
  contracts.set('CEXISTING', {
    address: 'CEXISTING',
    walletId: WALLET_A.id,
    deployerPubkey: WALLET_A.pubkey,
    deployedAt: new Date('2026-01-01'),
    deployTxHash: 'hash-1',
    network: 'testnet',
  });
  store.wallet.findMany = async () => [WALLET_A];

  const { horizon, fetchedTxHashes } = trackingHorizon(() => [createContractOp('hash-1')]);

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(fetchedTxHashes.length, 0, 'the transaction is never re-fetched');
  assert.equal(result.contractsFound, 0);
  assert.equal(contracts.size, 1, 'no duplicate contract row is created');
});

test('non-create-contract operations are ignored', async () => {
  const { store, contracts } = memoryStore();
  store.wallet.findMany = async () => [WALLET_A];
  const { horizon, fetchedTxHashes } = trackingHorizon(() => [
    { type: 'payment', transaction_hash: 'hash-2' },
    {
      type: 'invoke_host_function',
      function: 'HostFunctionTypeInvokeContract',
      transaction_hash: 'hash-3',
    },
  ]);

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(fetchedTxHashes.length, 0);
  assert.equal(result.contractsFound, 0);
  assert.equal(contracts.size, 0);
});

test('a Horizon failure on one wallet does not abort the others', async () => {
  const { store } = memoryStore();
  store.wallet.findMany = async () => [WALLET_A, WALLET_B];

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
  assert.deepEqual(scannedPubkeys, [WALLET_A.pubkey, WALLET_B.pubkey]);
});
