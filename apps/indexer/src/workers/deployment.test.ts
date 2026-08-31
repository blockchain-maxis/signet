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
const PAGE_LIMIT = 200;

const WALLET_A: DeploymentWallet = {
  id: 'w1',
  pubkey: 'GASAAEJC6P5UZGRLYJ2I2KYLR7RXGF44JZXDYGCFBN7T5VIHECUUEMCD',
  operationsCursor: null,
  operationsWatermark: null,
  backfillComplete: false,
};

function opRecord(token: string, type = 'payment'): { type: string; transaction_hash: string; paging_token: string } {
  return { type, transaction_hash: `tx-${token}`, paging_token: token };
}

/** Chunks a descending token list (newest → oldest) into desc-order pages keyed by the cursor that reaches them. */
function descPageMap(totalCount: number): Map<string, ReturnType<typeof opRecord>[]> {
  const tokens = Array.from({ length: totalCount }, (_, i) => String(totalCount - i));
  const map = new Map<string, ReturnType<typeof opRecord>[]>();
  let cursorKey = 'start';
  for (let i = 0; i < tokens.length; i += PAGE_LIMIT) {
    const chunk = tokens.slice(i, i + PAGE_LIMIT).map((t) => opRecord(t));
    map.set(cursorKey, chunk);
    cursorKey = chunk[chunk.length - 1]!.paging_token;
  }
  return map;
}

/** In-memory DeploymentStore; `wallets` is mutable so tests can inspect persisted progress. */
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
        Object.assign(w, data);
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

/** A fake Horizon whose operations().forAccount(pubkey) pages are looked up by (order, cursor). */
function fakeHorizon(
  pagesByPubkey: Record<string, { asc?: Map<string, unknown[]>; desc?: Map<string, unknown[]> }>,
): Horizon.Server {
  return {
    operations: () => ({
      forAccount: (pubkey: string) => {
        let order: 'asc' | 'desc' = 'desc';
        let cursor = 'start';
        const builder = {
          order(o: 'asc' | 'desc') {
            order = o;
            return builder;
          },
          limit() {
            return builder;
          },
          cursor(c: string) {
            cursor = c;
            return builder;
          },
          call: async () => ({ records: pagesByPubkey[pubkey]?.[order]?.get(cursor) ?? [] }),
        };
        return builder;
      },
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;
}

// ─── Backfill: the bug this issue is about ──────────────────────────────────

test('a wallet with 200 or fewer operations is fully backfilled in one tick', async () => {
  const wallets: DeploymentWallet[] = [{ ...WALLET_A }];
  const { store } = memoryStore(wallets);
  const horizon = fakeHorizon({
    [WALLET_A.pubkey]: { desc: descPageMap(150) },
  });

  await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(wallets[0]!.backfillComplete, true);
  assert.equal(wallets[0]!.operationsCursor, null);
  assert.equal(wallets[0]!.operationsWatermark, '150', 'watermark is the newest (first) record of the only page');
});

test('a wallet with more than MAX_PAGES_PER_TICK*200 operations resumes across ticks', async () => {
  // 13 pages: 12 full pages of 200 plus a final page of 50 — more than the
  // 10-page-per-tick bound, so this cannot finish in a single call.
  const total = 12 * 200 + 50;
  const wallets: DeploymentWallet[] = [{ ...WALLET_A }];
  const { store } = memoryStore(wallets);
  const horizon = fakeHorizon({
    [WALLET_A.pubkey]: { desc: descPageMap(total) },
  });

  await runDeploymentWorker(horizon, CONFIG, store);
  assert.equal(wallets[0]!.backfillComplete, false, 'the walk is bounded per tick — this wallet has more history than one tick covers');
  assert.ok(wallets[0]!.operationsCursor, 'progress was persisted so the next tick can resume');
  const cursorAfterFirstTick = wallets[0]!.operationsCursor;

  await runDeploymentWorker(horizon, CONFIG, store);
  assert.equal(wallets[0]!.backfillComplete, true, 'a second tick, resuming from the persisted cursor, reaches the end');
  assert.equal(wallets[0]!.operationsCursor, null);
  assert.notEqual(cursorAfterFirstTick, null);
});

test('backfill progress is persisted after every page, not only at the end', async () => {
  const total = 12 * 200 + 50; // needs 2 ticks, same as above
  const wallets: DeploymentWallet[] = [{ ...WALLET_A }];
  const { store, updateCalls } = memoryStore(wallets);
  const horizon = fakeHorizon({ [WALLET_A.pubkey]: { desc: descPageMap(total) } });

  await runDeploymentWorker(horizon, CONFIG, store);

  // 10 pages fetched in the first tick — one persisted update per page, so a
  // crash mid-backfill loses at most the in-flight page, not the whole walk.
  assert.equal(updateCalls.count, 10);
});

test('the watermark is captured from the very first page and survives to completion', async () => {
  const total = 12 * 200 + 50;
  const wallets: DeploymentWallet[] = [{ ...WALLET_A }];
  const { store } = memoryStore(wallets);
  const horizon = fakeHorizon({ [WALLET_A.pubkey]: { desc: descPageMap(total) } });

  await runDeploymentWorker(horizon, CONFIG, store); // tick 1
  assert.equal(wallets[0]!.operationsWatermark, String(total), 'newest record of the first page ever fetched');

  await runDeploymentWorker(horizon, CONFIG, store); // tick 2, completes
  assert.equal(
    wallets[0]!.operationsWatermark,
    String(total),
    'watermark does not change once set — it marks where steady-state catch-up resumes from, not the backfill position',
  );
});

// ─── Steady state: once backfill is complete, catch up forward from the watermark ──

test('a backfilled wallet catches up on new operations via a forward scan from its watermark', async () => {
  const wallet: DeploymentWallet = {
    ...WALLET_A,
    backfillComplete: true,
    operationsCursor: null,
    operationsWatermark: '500',
  };
  const wallets = [wallet];
  const { store } = memoryStore(wallets);
  const ascPages = new Map<string, ReturnType<typeof opRecord>[]>([
    ['500', [opRecord('501'), opRecord('502')]],
  ]);
  const horizon = fakeHorizon({ [WALLET_A.pubkey]: { asc: ascPages } });

  await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(wallets[0]!.operationsWatermark, '502', 'advances to the newest record seen');
  assert.equal(wallets[0]!.backfillComplete, true);
});

test('a backfilled wallet with nothing new does not move its watermark', async () => {
  const wallet: DeploymentWallet = {
    ...WALLET_A,
    backfillComplete: true,
    operationsCursor: null,
    operationsWatermark: '500',
  };
  const wallets = [wallet];
  const { store, updateCalls } = memoryStore(wallets);
  const horizon = fakeHorizon({ [WALLET_A.pubkey]: { asc: new Map() } }); // no page at cursor '500' → empty

  await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(wallets[0]!.operationsWatermark, '500');
  assert.equal(updateCalls.count, 0, 'no wasted write when there is nothing new');
});

// ─── Existing dedup / isolation behavior, unaffected by the above ───────────

test('an operation whose deployTxHash already has a contract is skipped without fetching the transaction', async () => {
  const wallet: DeploymentWallet = { ...WALLET_A, backfillComplete: true, operationsWatermark: '0' };
  const { store, contracts } = memoryStore([wallet]);
  contracts.set('CEXISTING', {
    address: 'CEXISTING',
    walletId: WALLET_A.id,
    deployerPubkey: WALLET_A.pubkey,
    deployedAt: new Date('2026-01-01'),
    deployTxHash: 'tx-1',
    network: 'testnet',
  });

  let fetched = 0;
  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            cursor: () => ({
              call: async () => ({
                records: [
                  { type: 'invoke_host_function', function: 'HostFunctionTypeCreateContract', transaction_hash: 'tx-1', paging_token: '1' },
                ],
              }),
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
  const wallet: DeploymentWallet = { ...WALLET_A, backfillComplete: true, operationsWatermark: '0' };
  const { store, contracts } = memoryStore([wallet]);
  const horizon = {
    operations: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            cursor: () => ({
              call: async () => ({
                records: [
                  { type: 'payment', transaction_hash: 'tx-2', paging_token: '1' },
                  { type: 'invoke_host_function', function: 'HostFunctionTypeInvokeContract', transaction_hash: 'tx-3', paging_token: '2' },
                ],
              }),
            }),
          }),
        }),
      }),
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(result.contractsFound, 0);
  assert.equal(contracts.size, 0);
});

test('a Horizon failure on one wallet does not abort the others', async () => {
  const walletA: DeploymentWallet = { ...WALLET_A, backfillComplete: true, operationsWatermark: '0' };
  const walletB: DeploymentWallet = {
    ...WALLET_A,
    id: 'w2',
    pubkey: 'GBVBJEP2BSKHW6YBFCZR2HJKHZDLJOU7ZKTH2HSNUUQY322RWLURH3EQ',
    backfillComplete: true,
    operationsWatermark: '0',
  };
  const { store } = memoryStore([walletA, walletB]);

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
                  if (call++ === 0) throw new Error('horizon exploded: status=400');
                  return { records: [] };
                },
              }),
            }),
          }),
        };
      },
    }),
    transactions: () => ({ transaction: () => ({ call: async () => ({}) }) }),
  } as unknown as Horizon.Server;

  const result = await runDeploymentWorker(horizon, CONFIG, store);

  assert.equal(result.walletsScanned, 2);
  assert.deepEqual(scannedPubkeys, [walletA.pubkey, walletB.pubkey]);
});
