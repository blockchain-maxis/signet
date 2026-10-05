import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runActivityWorker,
  type ActivityStore,
  type ActivityContract,
  type ActivityInvocation,
  type ContractSnapshotCreate,
} from './activity.ts';

const CONTRACT_A: ActivityContract = { id: 'c1', address: 'CAAA', snapshots: [] };
const CONTRACT_B: ActivityContract = { id: 'c2', address: 'CBBB', snapshots: [] };

const HOUR_MS = 60 * 60 * 1000;

/** An invocation `agoMs` before now. */
function inv(txHash: string, agoMs: number): ActivityInvocation {
  return { txHash, createdAt: new Date(Date.now() - agoMs) };
}

/**
 * In-memory `ActivityStore`. `contracts` is mutable so tests can add one
 * mid-run; `invocations` maps a contract id to its captured rows.
 */
function memoryStore(
  contracts: ActivityContract[],
  invocations: Record<string, ActivityInvocation[]> = {},
): {
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
    contractInvocation: {
      findMany: async ({ where }) => invocations[where.contractId] ?? [],
    },
  };
  return { store, snapshots };
}

test('a contract found between cycles gets its first snapshot on the next run, without a restart', async () => {
  const contracts: ActivityContract[] = [CONTRACT_A];
  const { store, snapshots } = memoryStore(contracts, {
    [CONTRACT_A.id]: [inv('t1', HOUR_MS)],
    [CONTRACT_B.id]: [inv('t2', HOUR_MS)],
  });

  const first = await runActivityWorker(store);
  assert.equal(first.snapshotsWritten, 1);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0]?.contractId, CONTRACT_A.id);

  // Simulate the deployment worker finding a new contract mid-life — from a
  // wallet linked after the indexer started — before this tick's activity
  // pass runs. The store's backing list grows; no restart is involved.
  contracts.push(CONTRACT_B);

  const second = await runActivityWorker(store);
  assert.equal(second.snapshotsWritten, 2, 'both the stale A and the brand-new B get a snapshot');
  assert.ok(snapshots.some((s) => s.contractId === CONTRACT_B.id));
});

test('a contract with a fresh snapshot is skipped', async () => {
  const fresh: ActivityContract = {
    id: 'c3',
    address: 'CFRESH',
    snapshots: [{ capturedAt: new Date() }],
  };
  const { store, snapshots } = memoryStore([fresh], { c3: [inv('t1', HOUR_MS)] });

  const result = await runActivityWorker(store);

  assert.equal(result.snapshotsWritten, 0);
  assert.equal(snapshots.length, 0);
});

test('a contract with a stale snapshot is refreshed', async () => {
  const stale: ActivityContract = {
    id: 'c4',
    address: 'CSTALE',
    snapshots: [{ capturedAt: new Date(Date.now() - 10 * 60 * 1000) }], // 10 min ago
  };
  const { store, snapshots } = memoryStore([stale], { c4: [inv('t1', HOUR_MS)] });

  const result = await runActivityWorker(store);

  assert.equal(result.snapshotsWritten, 1);
  assert.equal(snapshots[0]?.contractId, 'c4');
});

test('counts 24h vs total from invocation rows, with lastActivity and countedSince', async () => {
  const rows = [inv('recent', HOUR_MS), inv('old', 48 * HOUR_MS)];
  const { store, snapshots } = memoryStore([CONTRACT_A], { [CONTRACT_A.id]: rows });

  await runActivityWorker(store);

  assert.equal(snapshots[0]?.txCountTotal, 2);
  assert.equal(snapshots[0]?.txCount24h, 1);
  assert.equal(snapshots[0]?.lastActivity?.toISOString(), rows[0]?.createdAt.toISOString());
  assert.equal(snapshots[0]?.countedSince.toISOString(), rows[1]?.createdAt.toISOString());
});

test('the 24-hour window includes a row just inside it and excludes one just outside', async () => {
  const { store, snapshots } = memoryStore([CONTRACT_A], {
    [CONTRACT_A.id]: [inv('inside', 24 * HOUR_MS - 60_000), inv('outside', 24 * HOUR_MS + 60_000)],
  });

  await runActivityWorker(store);

  assert.equal(snapshots[0]?.txCount24h, 1);
  assert.equal(snapshots[0]?.txCountTotal, 2);
});

test('one transaction with several invocations is counted once', async () => {
  const { store, snapshots } = memoryStore([CONTRACT_A], {
    [CONTRACT_A.id]: [
      inv('same', HOUR_MS),
      inv('same', HOUR_MS),
      inv('same', 2 * HOUR_MS),
      inv('other', 3 * HOUR_MS),
    ],
  });

  await runActivityWorker(store);

  assert.equal(snapshots[0]?.txCountTotal, 2);
  assert.equal(snapshots[0]?.txCount24h, 2);
});

test('a contract with no captured invocations writes no snapshot', async () => {
  const { store, snapshots } = memoryStore([CONTRACT_A]);

  const result = await runActivityWorker(store);

  assert.equal(result.snapshotsWritten, 0);
  assert.equal(snapshots.length, 0);
});

test('totalIsFloor is set when the rows reach the cap, and not below it', async () => {
  const rows = [inv('t1', HOUR_MS), inv('t2', 2 * HOUR_MS), inv('t3', 3 * HOUR_MS)];
  const { store, snapshots } = memoryStore([CONTRACT_A, CONTRACT_B], {
    [CONTRACT_A.id]: rows,
    [CONTRACT_B.id]: rows.slice(0, 2),
  });

  await runActivityWorker(store, { invocationsMaxPerContract: 3 });

  assert.equal(snapshots.find((s) => s.contractId === CONTRACT_A.id)?.totalIsFloor, true);
  assert.equal(snapshots.find((s) => s.contractId === CONTRACT_B.id)?.totalIsFloor, false);
});

test('totalIsFloor stays false when the cap is disabled (0)', async () => {
  const { store, snapshots } = memoryStore([CONTRACT_A], {
    [CONTRACT_A.id]: [inv('t1', HOUR_MS), inv('t2', 2 * HOUR_MS)],
  });

  await runActivityWorker(store, { invocationsMaxPerContract: 0 });

  assert.equal(snapshots[0]?.totalIsFloor, false);
});

test('a store failure logs and writes nothing, and other contracts still run', async () => {
  const snapshots: ContractSnapshotCreate[] = [];
  const store: ActivityStore = {
    contract: { findMany: async () => [CONTRACT_A, CONTRACT_B] },
    contractSnapshot: {
      create: async ({ data }) => {
        snapshots.push(data);
      },
    },
    contractInvocation: {
      findMany: async ({ where }) => {
        if (where.contractId === CONTRACT_A.id) throw new Error('db exploded');
        return [inv('t1', HOUR_MS)];
      },
    },
  };

  const result = await runActivityWorker(store);

  assert.equal(result.snapshotsWritten, 1);
  assert.deepEqual(
    snapshots.map((s) => s.contractId),
    [CONTRACT_B.id],
  );
});
