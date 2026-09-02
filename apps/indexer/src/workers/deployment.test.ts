import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr, StrKey, type Horizon } from '@stellar/stellar-sdk';
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

/**
 * Builds a real, minimal Soroban V3 `result_meta_xdr` whose sorobanMeta
 * return value is the given contract address — exactly the shape
 * `extractContractAddress` (stellar.ts) parses. Exercising the real parser
 * (rather than stubbing it out) is what makes the dedup tests below prove the
 * fix against the actual extraction path, not just the store calls around it.
 */
function contractCreationMetaXdr(contractAddress: string): string {
  const contractId = StrKey.decodeContract(contractAddress);
  // The SDK's own .d.ts models Hash/ContractId as Opaque[] ("workaround,
  // cause unknown" per its comment) but the runtime opaque-array type accepts
  // a Buffer directly — this cast bridges that gap.
  const scAddress = xdr.ScAddress.scAddressTypeContract(
    contractId as unknown as Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0],
  );
  const returnValue = xdr.ScVal.scvAddress(scAddress);
  const sorobanMeta = new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events: [],
    returnValue,
    diagnosticEvents: [],
  });
  const v3 = new xdr.TransactionMetaV3({
    ext: new xdr.ExtensionPoint(0),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta,
  });
  return new xdr.TransactionMeta(3, v3).toXDR('base64');
}

const CONTRACT_ONE = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const CONTRACT_TWO = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';

/** In-memory `DeploymentStore` keyed on contract address, mirroring the real unique constraint. */
function memoryStore(): {
  store: DeploymentStore;
  contracts: Map<string, ContractCreate>;
} {
  const contracts = new Map<string, ContractCreate>();
  const store: DeploymentStore = {
    wallet: { findMany: async () => [] },
    contract: {
      findFirst: async ({ where }) => {
        if ('deployTxHash' in where) {
          const found = [...contracts.values()].find((c) => c.deployTxHash === where.deployTxHash);
          return found ? { id: found.address } : null;
        }
        const found = contracts.get(where.address);
        return found ? { id: found.address } : null;
      },
      upsert: async ({ create }) => {
        // Mirrors Prisma's upsert-with-empty-update semantics: an existing
        // row is left exactly as it was.
        if (!contracts.has(create.address)) {
          contracts.set(create.address, create);
        }
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
 * A Horizon stub: `recordsFor` controls what operations come back per wallet
 * pubkey, and `metaFor` controls the transaction fetched for a given tx hash.
 * `fetchedTxHashes` records which transactions were actually fetched.
 */
function fakeHorizon(
  recordsFor: (pubkey: string) => unknown[],
  metaFor: (txHash: string) => string,
) {
  const fetchedTxHashes: string[] = [];
  const scannedPubkeys: string[] = [];
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
            result_meta_xdr: metaFor(txHash),
            ledger_attr: 2,
            created_at: '2026-01-01T00:00:00Z',
          }),
        };
      },
    }),
  } as unknown as Horizon.Server;
  return { horizon, fetchedTxHashes, scannedPubkeys };
}

test('the same contract discovered via two wallets on the same profile is recorded once, attributed to the first', async () => {
  const { store, contracts } = memoryStore();
  store.wallet.findMany = async () => [WALLET_A, WALLET_B];

  // Two different wallets, two different transactions — but both transactions
  // report the SAME contract address, exactly the "reached from more than one
  // scan path" scenario a multi-wallet profile can hit.
  const { horizon, fetchedTxHashes } = fakeHorizon(
    (pubkey) =>
      pubkey === WALLET_A.pubkey ? [createContractOp('hash-a')] : [createContractOp('hash-b')],
    () => contractCreationMetaXdr(CONTRACT_ONE),
  );

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(contracts.size, 1, 'only one Contract row exists for the one address');
  assert.equal(
    contracts.get(CONTRACT_ONE)?.walletId,
    WALLET_A.id,
    'attributed to the first wallet scanned',
  );
  assert.equal(result.contractsFound, 1, 'the second discovery is not counted as a new contract');
  // Both transactions ARE fetched — the address is only knowable after
  // extraction — but only the first produces a new row.
  assert.deepEqual(fetchedTxHashes, ['hash-a', 'hash-b']);
});

test('re-running over the same fixture does not re-attribute or duplicate the contract', async () => {
  const { store, contracts } = memoryStore();
  store.wallet.findMany = async () => [WALLET_A];
  const { horizon } = fakeHorizon(
    () => [createContractOp('hash-a')],
    () => contractCreationMetaXdr(CONTRACT_ONE),
  );

  await runDeploymentWorker(horizon, CONFIG, store);
  const first = contracts.get(CONTRACT_ONE);
  assert.ok(first);

  const second = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(contracts.size, 1);
  assert.deepEqual(contracts.get(CONTRACT_ONE), first, 'the row is untouched on the second run');
  assert.equal(
    second.contractsFound,
    0,
    'nothing new is found the second time — the tx-hash guard catches it first',
  );
});

test('two different contracts from two wallets are both recorded, each to its own wallet', async () => {
  const { store, contracts } = memoryStore();
  store.wallet.findMany = async () => [WALLET_A, WALLET_B];
  const { horizon } = fakeHorizon(
    (pubkey) =>
      pubkey === WALLET_A.pubkey ? [createContractOp('hash-a')] : [createContractOp('hash-b')],
    (txHash) => contractCreationMetaXdr(txHash === 'hash-a' ? CONTRACT_ONE : CONTRACT_TWO),
  );

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(contracts.size, 2);
  assert.equal(contracts.get(CONTRACT_ONE)?.walletId, WALLET_A.id);
  assert.equal(contracts.get(CONTRACT_TWO)?.walletId, WALLET_B.id);
  assert.equal(result.contractsFound, 2);
});

test('an operation whose deployTxHash already has a contract is skipped without fetching the transaction', async () => {
  const { store, contracts } = memoryStore();
  contracts.set(CONTRACT_ONE, {
    address: CONTRACT_ONE,
    walletId: WALLET_A.id,
    deployerPubkey: WALLET_A.pubkey,
    deployedAt: new Date('2026-01-01'),
    deployTxHash: 'hash-a',
    network: 'testnet',
  });
  store.wallet.findMany = async () => [WALLET_A];

  const { horizon, fetchedTxHashes } = fakeHorizon(
    () => [createContractOp('hash-a')],
    () => contractCreationMetaXdr(CONTRACT_ONE),
  );

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(fetchedTxHashes.length, 0, 'the transaction is never re-fetched');
  assert.equal(result.contractsFound, 0);
  assert.equal(contracts.size, 1, 'no duplicate contract row is created');
});

test('non-create-contract operations are ignored', async () => {
  const { store, contracts } = memoryStore();
  store.wallet.findMany = async () => [WALLET_A];
  const { horizon, fetchedTxHashes } = fakeHorizon(
    () => [
      { type: 'payment', transaction_hash: 'hash-2' },
      {
        type: 'invoke_host_function',
        function: 'HostFunctionTypeInvokeContract',
        transaction_hash: 'hash-3',
      },
    ],
    () => contractCreationMetaXdr(CONTRACT_ONE),
  );

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

test('a wallet linked between cycles is scanned on the next run, without a restart', async () => {
  const { store } = memoryStore();
  const wallets: DeploymentWallet[] = [WALLET_A];
  store.wallet.findMany = async () => wallets;
  const { horizon, scannedPubkeys } = fakeHorizon(
    () => [],
    () => '',
  );

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
