import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Horizon } from '@stellar/stellar-sdk';
import {
  runActivityWorker,
  type ActivityStore,
  type ActivityContract,
  type ContractSnapshotCreate,
} from './activity.ts';

const CONTRACT_A: ActivityContract = { id: 'c1', address: 'CAAA', snapshots: [] };
const CONTRACT_B: ActivityContract = { id: 'c2', address: 'CBBB', snapshots: [] };

/** In-memory `ActivityStore`; `contracts` is mutable so tests can add one mid-run. */
function memoryStore(contracts: ActivityContract[]): {
  store: ActivityStore;
  snapshots: ContractSnapshotCreate[];
} {
  const snapshots: ContractSnapshotCreate[] = [];
  const store: ActivityStore = {
    contract: { findMany: async () => contracts },
    contractSnapshot: {
      create: async ({ data }) => {
        snapshots.push(data);
      },
    },
  };
  return { store, snapshots };
}

function horizonReturning(records: unknown[]): Horizon.Server {
  return {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records }),
          }),
        }),
      }),
    }),
  } as unknown as Horizon.Server;
}

function tx(createdAt: string) {
  return { created_at: createdAt };
}

test('a contract found between cycles gets its first snapshot on the next run, without a restart', async () => {
  const contracts: ActivityContract[] = [CONTRACT_A];
  const { store, snapshots } = memoryStore(contracts);
  const horizon = horizonReturning([tx('2026-03-04T00:00:00Z')]);

  const first = await runActivityWorker(horizon, store);
  assert.equal(first.snapshotsWritten, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.contractId, CONTRACT_A.id);

  // Simulate the deployment worker finding a new contract mid-life — from a
  // wallet linked after the indexer started — before this tick's activity
  // pass runs. The store's backing list grows; no restart is involved.
  contracts.push(CONTRACT_B);

  const second = await runActivityWorker(horizon, store);
  assert.equal(second.snapshotsWritten, 2, 'both the stale A and the brand-new B get a snapshot');
  assert.ok(snapshots.some((s) => s.contractId === CONTRACT_B.id));
});

test('a contract with a fresh snapshot is skipped', async () => {
  const fresh: ActivityContract = {
    id: 'c3',
    address: 'CFRESH',
    snapshots: [{ capturedAt: new Date() }],
  };
  const { store, snapshots } = memoryStore([fresh]);

  const result = await runActivityWorker(horizonReturning([]), store);

  assert.equal(result.snapshotsWritten, 0);
  assert.equal(snapshots.length, 0);
});

test('a contract with a stale snapshot is refreshed', async () => {
  const stale: ActivityContract = {
    id: 'c4',
    address: 'CSTALE',
    snapshots: [{ capturedAt: new Date(Date.now() - 10 * 60 * 1000) }], // 10 min ago
  };
  const { store, snapshots } = memoryStore([stale]);

  const result = await runActivityWorker(horizonReturning([tx('2026-03-04T00:00:00Z')]), store);

  assert.equal(result.snapshotsWritten, 1);
  assert.equal(snapshots[0]?.contractId, 'c4');
});

test('counts 24h vs total transactions and tracks the most recent activity', async () => {
  const { store, snapshots } = memoryStore([CONTRACT_A]);
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 2 days ago

  await runActivityWorker(horizonReturning([tx(recent), tx(old)]), store);

  assert.equal(snapshots[0]?.txCountTotal, 2);
  assert.equal(snapshots[0]?.txCount24h, 1);
  assert.equal(snapshots[0]?.lastActivity?.toISOString(), new Date(recent).toISOString());
});

test('a Horizon failure degrades to zero counts instead of throwing', async () => {
  const { store, snapshots } = memoryStore([CONTRACT_A]);
  const horizon = {
    transactions: () => ({
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
  } as unknown as Horizon.Server;

  const result = await runActivityWorker(horizon, store);

  assert.equal(result.snapshotsWritten, 1);
  assert.equal(snapshots[0]?.txCountTotal, 0);
  assert.equal(snapshots[0]?.txCount24h, 0);
  assert.equal(snapshots[0]?.lastActivity, null);
});
