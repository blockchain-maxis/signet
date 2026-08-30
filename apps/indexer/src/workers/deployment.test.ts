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
  deploymentCursor: null,
  deploymentBackfilledAt: null,
};

/** In-memory `DeploymentStore`. Wallets are mutable so tests can inspect the cursor/backfill writes. */
function memoryStore(wallets: DeploymentWallet[]): {
  store: DeploymentStore;
  contracts: Map<string, ContractCreate>;
} {
  const contracts = new Map<string, ContractCreate>();
  const store: DeploymentStore = {
    wallet: {
      findMany: async () => wallets,
      update: async ({ where, data }) => {
        const w = wallets.find((x) => x.id === where.id);
        if (!w) throw new Error(`no wallet ${where.id}`);
        if ('deploymentCursor' in data) w.deploymentCursor = data.deploymentCursor ?? null;
        if (data.deploymentBackfilledAt) w.deploymentBackfilledAt = data.deploymentBackfilledAt;
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
  return { store, contracts };
}

function paymentOp(txHash: string, pagingToken: string) {
  return { type: 'payment', transaction_hash: txHash, paging_token: pagingToken };
}

/**
 * A paginated Horizon stub for one wallet's `.operations()` call chain.
 * `pages` is oldest-last (Horizon's own newest-first order); each element is
 * one page's records. Tracks the cursor value `.cursor()` was called with (or
 * "none") and how many pages were actually fetched.
 */
function horizonPages(pages: unknown[][]) {
  const calls = { cursorUsed: undefined as string | undefined, pagesFetched: 0 };

  function pageAt(i: number): unknown {
    calls.pagesFetched++;
    return {
      records: pages[i] ?? [],
      next: async () => pageAt(i + 1),
    };
  }

  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            cursor: (c: string) => {
              calls.cursorUsed = c;
              return { call: async () => pageAt(0) };
            },
            call: async () => pageAt(0),
          }),
        }),
      }),
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;

  return { horizon, calls };
}

test('a fresh wallet with a small backlog fully backfills in one tick', async () => {
  const wallets = [{ ...WALLET_A }];
  const { store } = memoryStore(wallets);
  const { horizon, calls } = horizonPages([
    [paymentOp('h3', 'tok-3'), paymentOp('h2', 'tok-2')],
    [paymentOp('h1', 'tok-1')],
  ]);

  await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(calls.cursorUsed, undefined, 'the first backfill tick uses no cursor — starts at the newest op');
  // 2 data pages + the empty page that signals exhaustion.
  assert.equal(calls.pagesFetched, 3);
  assert.ok(wallets[0]!.deploymentBackfilledAt, 'backfill is marked complete once Horizon returns empty');
  assert.equal(wallets[0]!.deploymentCursor, 'tok-1', 'the cursor lands on the oldest op reached');
});

test('a wallet with more history than one tick allows partially backfills and resumes next tick', async () => {
  const wallets = [{ ...WALLET_A }];
  const { store } = memoryStore(wallets);

  // 15 pages of 2 ops each — more than MAX_PAGES_PER_TICK (10) allows in one tick.
  const pages = Array.from({ length: 15 }, (_, i) => [
    paymentOp(`h${i}a`, `tok-${i}a`),
    paymentOp(`h${i}b`, `tok-${i}b`),
  ]);
  const { horizon: firstHorizon, calls: firstCalls } = horizonPages(pages);

  await runDeploymentWorker(firstHorizon, CONFIG, store);

  assert.equal(firstCalls.pagesFetched, 10, 'no more than MAX_PAGES_PER_TICK pages are read in one tick');
  assert.equal(wallets[0]!.deploymentBackfilledAt, null, 'backfill is not yet complete');
  const cursorAfterTick1 = wallets[0]!.deploymentCursor;
  assert.equal(cursorAfterTick1, 'tok-9b', 'the cursor lands on the oldest op read this tick');

  // Second tick: resumes from the saved cursor, not from the top.
  const { horizon: secondHorizon, calls: secondCalls } = horizonPages(pages.slice(10));
  await runDeploymentWorker(secondHorizon, CONFIG, store);

  assert.equal(secondCalls.cursorUsed, cursorAfterTick1, 'the second tick resumes exactly where the first left off');
  assert.ok(wallets[0]!.deploymentBackfilledAt, 'backfill completes on the tick that exhausts the history');
});

test('an already-backfilled wallet uses the quick-check path, not pagination', async () => {
  const wallets: DeploymentWallet[] = [
    { ...WALLET_A, deploymentCursor: 'tok-old', deploymentBackfilledAt: new Date('2026-01-01') },
  ];
  const { store } = memoryStore(wallets);

  let calledCursor = false;
  let calls = 0;
  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            cursor: () => {
              calledCursor = true;
              return { call: async () => ({ records: [] }) };
            },
            call: async () => {
              calls++;
              return { records: [paymentOp('h1', 'tok-1')] };
            },
          }),
        }),
      }),
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;

  await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(calledCursor, false, 'quick-check never resumes from a cursor');
  assert.equal(calls, 1, 'quick-check is a single bounded call, not a paginated walk');
  assert.equal(
    wallets[0]!.deploymentCursor,
    'tok-old',
    'quick-check does not touch the cursor once backfill is already complete',
  );
});

// ─── Contract detection, through the real extraction path ──────────────────

function contractCreationMetaXdr(contractAddress: string): string {
  const contractId = StrKey.decodeContract(contractAddress);
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

function createContractOp(txHash: string, pagingToken: string) {
  return {
    type: 'invoke_host_function',
    function: 'HostFunctionTypeCreateContract',
    transaction_hash: txHash,
    paging_token: pagingToken,
  };
}

test('a create-contract op is detected and recorded during backfill', async () => {
  const wallets = [{ ...WALLET_A }];
  const { store, contracts } = memoryStore(wallets);
  const { horizon } = horizonPages([[createContractOp('hash-a', 'tok-1')]]);
  horizon.transactions = (() => ({
    transaction: () => ({
      call: async () => ({
        result_meta_xdr: contractCreationMetaXdr(CONTRACT_ONE),
        ledger_attr: 2,
        created_at: '2026-01-01T00:00:00Z',
      }),
    }),
  })) as unknown as Horizon.Server['transactions'];

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(result.contractsFound, 1);
  assert.equal(contracts.get(CONTRACT_ONE)?.walletId, WALLET_A.id);
});

test('a Horizon failure on one wallet does not abort the others', async () => {
  const walletB: DeploymentWallet = { ...WALLET_A, id: 'w2', pubkey: 'GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ' };
  const wallets = [{ ...WALLET_A }, walletB];
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
              cursor: () => ({
                call: async () => {
                  throw new Error('should not be reached — first backfill tick uses no cursor');
                },
              }),
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
