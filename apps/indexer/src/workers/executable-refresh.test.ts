import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr, Address, Contract } from '@stellar/stellar-sdk';
import {
  runExecutableRefreshWorker,
  type ExecutableRefreshContract,
  type ExecutableRefreshStore,
  type SorobanRpcLike,
} from './executable-refresh.js';
import type { IndexerConfig } from '../config.js';

const CONFIG: IndexerConfig = {
  databaseUrl: 'postgresql://mock',
  network: 'testnet',
  horizonUrl: 'https://mock-horizon',
  rpcUrl: 'https://mock-rpc',
  tickIntervalMs: 30_000,
  logLevel: 'info',
  registryContractId: '',
  eventWindowLedgers: 8_000,
  operationsRetentionDays: 90,
  snapshotsRetentionDays: 30,
  captureInvocations: true,
  invocationsMaxPerContract: 1000,
  pruneIntervalMs: 3_600_000,
  executableRefreshIntervalMs: 21_600_000, // 6h
};

interface VersionRecord {
  id: string;
  contractId: string;
  wasmHash: string;
  observedLedger: number;
}

function createMemoryStore(initialContracts: ExecutableRefreshContract[]) {
  const contracts = new Map<string, ExecutableRefreshContract>();
  for (const c of initialContracts) {
    contracts.set(c.id, { ...c });
  }

  const versions: VersionRecord[] = [];

  const store: ExecutableRefreshStore = {
    contract: {
      findMany: async ({ where }) => {
        const results: ExecutableRefreshContract[] = [];
        for (const c of contracts.values()) {
          const isNull = c.wasmHashCheckedAt === null;
          const isOlder =
            where.OR[1].wasmHashCheckedAt?.lte &&
            c.wasmHashCheckedAt !== null &&
            c.wasmHashCheckedAt <= where.OR[1].wasmHashCheckedAt.lte;
          if (isNull || isOlder) {
            results.push({ ...c });
          }
        }
        return results;
      },
      update: async ({ where, data }) => {
        const c = contracts.get(where.id);
        if (!c) throw new Error(`Contract not found: ${where.id}`);
        if (data.wasmHash !== undefined) {
          c.wasmHash = data.wasmHash;
        }
        if (data.wasmHashCheckedAt !== undefined) {
          c.wasmHashCheckedAt = data.wasmHashCheckedAt;
        }
      },
    },
    contractWasmVersion: {
      upsert: async ({ where, create }) => {
        const existing = versions.find(
          (v) =>
            v.contractId === where.contractId_wasmHash.contractId &&
            v.wasmHash === where.contractId_wasmHash.wasmHash,
        );
        if (!existing) {
          versions.push({
            id: `v-${versions.length + 1}`,
            contractId: create.contractId,
            wasmHash: create.wasmHash,
            observedLedger: create.observedLedger,
          });
        }
      },
    },
  };

  return { store, contracts, versions };
}

function makeWasmEntry(
  addressStr: string,
  wasmHashHex: string,
): { key: xdr.LedgerKey; val: xdr.LedgerEntryData } {
  const hash = Buffer.from(wasmHashHex, 'hex');
  const exec = xdr.ContractExecutable.contractExecutableWasm(hash);
  const instance = new xdr.ScContractInstance({ executable: exec, storage: null });
  const scVal = xdr.ScVal.scvContractInstance(instance);
  const addr = Address.fromString(addressStr);
  const data = new xdr.ContractDataEntry({
    contract: addr.toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: scVal,
    ext: new xdr.ExtensionPoint(0),
  });
  const entryData = xdr.LedgerEntryData.contractData(data);
  const key = new Contract(addressStr).getFootprint();
  return { key, val: entryData };
}

const CONTRACT_A = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const CONTRACT_B = 'CCZ54NTEOVL2DKWCGJA5XHTHOGRDS7JHFKYWEC6QH2IMZLYNM3FBFKDG';
const HASH_1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_3 = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

test('a null hash gets backfilled', async () => {
  const { store, contracts, versions } = createMemoryStore([
    {
      id: 'c1',
      address: CONTRACT_A,
      wasmHash: null,
      wasmHashCheckedAt: null,
    },
  ]);

  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async () => ({
      latestLedger: 1000,
      entries: [makeWasmEntry(CONTRACT_A, HASH_1)],
    }),
  };

  const now = new Date('2026-09-26T12:00:00Z');
  const result = await runExecutableRefreshWorker(mockRpc, CONFIG, store, now);

  assert.equal(result.contractsChecked, 1);
  assert.equal(result.wasmChanged, 1);
  assert.equal(result.missingEntries, 0);

  const updated = contracts.get('c1')!;
  assert.equal(updated.wasmHash, HASH_1);
  assert.equal(updated.wasmHashCheckedAt?.toISOString(), now.toISOString());

  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.contractId, 'c1');
  assert.equal(versions[0]!.wasmHash, HASH_1);
  assert.equal(versions[0]!.observedLedger, 1000);
});

test('an unchanged hash only bumps wasmHashCheckedAt', async () => {
  const prevCheckedAt = new Date('2026-09-26T00:00:00Z');
  const { store, contracts, versions } = createMemoryStore([
    {
      id: 'c1',
      address: CONTRACT_A,
      wasmHash: HASH_1,
      wasmHashCheckedAt: prevCheckedAt,
    },
  ]);

  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async () => ({
      latestLedger: 1050,
      entries: [makeWasmEntry(CONTRACT_A, HASH_1)],
    }),
  };

  const now = new Date('2026-09-26T12:00:00Z');
  const result = await runExecutableRefreshWorker(mockRpc, CONFIG, store, now);

  assert.equal(result.contractsChecked, 1);
  assert.equal(result.wasmChanged, 0);
  assert.equal(result.missingEntries, 0);

  const updated = contracts.get('c1')!;
  assert.equal(updated.wasmHash, HASH_1);
  assert.equal(updated.wasmHashCheckedAt?.toISOString(), now.toISOString());
  assert.equal(versions.length, 0);
});

test('a changed hash updates the row and adds exactly one version row', async () => {
  const prevCheckedAt = new Date('2026-09-26T00:00:00Z');
  const { store, contracts, versions } = createMemoryStore([
    {
      id: 'c1',
      address: CONTRACT_A,
      wasmHash: HASH_1,
      wasmHashCheckedAt: prevCheckedAt,
    },
  ]);

  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async () => ({
      latestLedger: 2000,
      entries: [makeWasmEntry(CONTRACT_A, HASH_2)],
    }),
  };

  const now = new Date('2026-09-26T12:00:00Z');
  const result = await runExecutableRefreshWorker(mockRpc, CONFIG, store, now);

  assert.equal(result.contractsChecked, 1);
  assert.equal(result.wasmChanged, 1);
  assert.equal(result.missingEntries, 0);

  const updated = contracts.get('c1')!;
  assert.equal(updated.wasmHash, HASH_2);
  assert.equal(updated.wasmHashCheckedAt?.toISOString(), now.toISOString());

  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.contractId, 'c1');
  assert.equal(versions[0]!.wasmHash, HASH_2);
  assert.equal(versions[0]!.observedLedger, 2000);
});

test('a missing entry changes nothing except wasmHashCheckedAt', async () => {
  const prevCheckedAt = new Date('2026-09-26T00:00:00Z');
  const { store, contracts, versions } = createMemoryStore([
    {
      id: 'c1',
      address: CONTRACT_A,
      wasmHash: HASH_1,
      wasmHashCheckedAt: prevCheckedAt,
    },
  ]);

  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async () => ({
      latestLedger: 2500,
      entries: [], // missing entry
    }),
  };

  const now = new Date('2026-09-26T12:00:00Z');
  const result = await runExecutableRefreshWorker(mockRpc, CONFIG, store, now);

  assert.equal(result.contractsChecked, 1);
  assert.equal(result.wasmChanged, 0);
  assert.equal(result.missingEntries, 1);

  const updated = contracts.get('c1')!;
  assert.equal(updated.wasmHash, HASH_1); // preserved
  assert.equal(updated.wasmHashCheckedAt?.toISOString(), now.toISOString());
  assert.equal(versions.length, 0);
});

test('more than 100 contracts are split into multiple calls', async () => {
  const contractList: ExecutableRefreshContract[] = [];
  for (let i = 0; i < 150; i++) {
    // Generate valid C... addresses for test using CONTRACT_A as base
    contractList.push({
      id: `c-${i}`,
      address: CONTRACT_A,
      wasmHash: null,
      wasmHashCheckedAt: null,
    });
  }

  const { store } = createMemoryStore(contractList);

  let callsCount = 0;
  const batchSizes: number[] = [];

  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async (...keys) => {
      callsCount++;
      batchSizes.push(keys.length);
      return {
        latestLedger: 3000,
        entries: [],
      };
    },
  };

  const now = new Date('2026-09-26T12:00:00Z');
  const result = await runExecutableRefreshWorker(mockRpc, CONFIG, store, now);

  assert.equal(result.contractsChecked, 150);
  assert.equal(callsCount, 2);
  assert.deepEqual(batchSizes, [100, 50]);
});

test('a contract upgraded twice ends with 3 version rows and never duplicates one, including rollback', async () => {
  const { store, contracts, versions } = createMemoryStore([
    {
      id: 'c1',
      address: CONTRACT_A,
      wasmHash: null,
      wasmHashCheckedAt: null,
    },
  ]);

  // Initial detection: HASH_1
  let currentHash = HASH_1;
  let ledger = 1000;
  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async () => ({
      latestLedger: ledger,
      entries: [makeWasmEntry(CONTRACT_A, currentHash)],
    }),
  };

  let t = new Date('2026-09-26T01:00:00Z');
  await runExecutableRefreshWorker(mockRpc, CONFIG, store, t);
  assert.equal(contracts.get('c1')!.wasmHash, HASH_1);
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!.wasmHash, HASH_1);

  // Upgrade 1: HASH_2
  currentHash = HASH_2;
  ledger = 2000;
  t = new Date('2026-09-26T08:00:00Z'); // 7h later (> 6h)
  await runExecutableRefreshWorker(mockRpc, CONFIG, store, t);
  assert.equal(contracts.get('c1')!.wasmHash, HASH_2);
  assert.equal(versions.length, 2);
  assert.equal(versions[1]!.wasmHash, HASH_2);

  // Upgrade 2: HASH_3
  currentHash = HASH_3;
  ledger = 3000;
  t = new Date('2026-09-26T15:00:00Z'); // 7h later
  await runExecutableRefreshWorker(mockRpc, CONFIG, store, t);
  assert.equal(contracts.get('c1')!.wasmHash, HASH_3);
  assert.equal(versions.length, 3);
  assert.equal(versions[2]!.wasmHash, HASH_3);

  // Rollback to HASH_1: updates current hash, but upsert prevents adding duplicate version row
  currentHash = HASH_1;
  ledger = 4000;
  t = new Date('2026-09-26T22:00:00Z'); // 7h later
  await runExecutableRefreshWorker(mockRpc, CONFIG, store, t);
  assert.equal(contracts.get('c1')!.wasmHash, HASH_1);
  assert.equal(versions.length, 3); // Still 3 unique versions!
});

test('a failing write for one contract does not stop the rest of the batch', async () => {
  const { store, contracts, versions } = createMemoryStore([
    { id: 'c1', address: CONTRACT_A, wasmHash: null, wasmHashCheckedAt: null },
    { id: 'c2', address: CONTRACT_B, wasmHash: null, wasmHashCheckedAt: null },
  ]);
  const realUpdate = store.contract.update;
  store.contract.update = async (args) => {
    if (args.where.id === 'c1') throw new Error('db down for c1');
    return realUpdate(args);
  };

  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async () => ({
      latestLedger: 1000,
      entries: [makeWasmEntry(CONTRACT_A, HASH_1), makeWasmEntry(CONTRACT_B, HASH_2)],
    }),
  };

  const now = new Date('2026-09-26T12:00:00Z');
  const result = await runExecutableRefreshWorker(mockRpc, CONFIG, store, now);

  assert.equal(result.wasmChanged, 1, 'only the healthy contract counts as changed');
  assert.equal(contracts.get('c2')!.wasmHash, HASH_2);
  assert.equal(contracts.get('c1')!.wasmHash, null, 'c1 stays due for the next tick');
  assert.equal(contracts.get('c1')!.wasmHashCheckedAt, null);
  assert.ok(versions.some((v) => v.contractId === 'c2' && v.wasmHash === HASH_2));
});

test('the version row is written before the Contract row, so a failed update is retried, not lost', async () => {
  const { store, contracts, versions } = createMemoryStore([
    { id: 'c1', address: CONTRACT_A, wasmHash: HASH_1, wasmHashCheckedAt: null },
  ]);
  const realUpdate = store.contract.update;
  let failNext = true;
  store.contract.update = async (args) => {
    if (failNext) {
      failNext = false;
      throw new Error('transient');
    }
    return realUpdate(args);
  };

  const mockRpc: SorobanRpcLike = {
    getLedgerEntries: async () => ({
      latestLedger: 2000,
      entries: [makeWasmEntry(CONTRACT_A, HASH_2)],
    }),
  };

  await runExecutableRefreshWorker(mockRpc, CONFIG, store, new Date('2026-09-26T12:00:00Z'));
  assert.equal(contracts.get('c1')!.wasmHash, HASH_1, 'Contract row not yet updated');
  assert.equal(versions.length, 1, 'version already recorded');

  await runExecutableRefreshWorker(mockRpc, CONFIG, store, new Date('2026-09-26T12:01:00Z'));
  assert.equal(contracts.get('c1')!.wasmHash, HASH_2, 'retry completes the update');
  assert.equal(versions.length, 1, 'no duplicate version row');
});
