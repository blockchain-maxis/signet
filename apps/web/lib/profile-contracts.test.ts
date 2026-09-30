import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getProfileContractsWithDeps,
  type ProfileContractsDb,
  type ProfileContractsDbRow,
  type ProfileContractsHorizon,
  type ProfileContractsHorizonOp,
} from './profile-contracts.ts';
import { HORIZON_MAX_RECORDS } from './server/horizon.ts';

// Chain-confirmed create-contract vector (see contract-attribution.test.ts):
// this deployer, salt and passphrase reproduce the exact contract address the
// testnet network assigned.
const DEPLOYER = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const SALT_HEX = '075afa7ea513abbddc97610bbef3276c89be0a040c3e914920dd7efb424a6ad6';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const NETWORK = 'testnet' as const;
const OTHER_DEPLOYER = `G${'B'.repeat(55)}`;

type DbContractSeed = {
  address: string;
  walletId: string;
  network: string;
  deployerPubkey: string;
  deployTxHash: string;
  deployedAt: Date;
  wasmHash: string | null;
};

function makeDb(
  rows: DbContractSeed[],
  walletCount: number,
  calls: { db: number },
): ProfileContractsDb {
  return {
    listContracts: async (): Promise<{
      contracts: ProfileContractsDbRow[];
      walletCount: number;
    }> => {
      calls.db += 1;
      return {
        contracts: rows.map((r) => ({ ...r, walletPubkey: r.deployerPubkey })),
        walletCount,
      };
    },
  };
}

/** A database that is entirely absent: unset DATABASE_URL or unreachable. */
const noDb: ProfileContractsDb = {
  listContracts: async () => undefined,
};

function makeHorizon(
  wallet: string | null,
  ops: ProfileContractsHorizonOp[],
  calls: { wallets: number; operations: number; meta: number },
  opts: { truncated?: boolean } = {},
): ProfileContractsHorizon {
  return {
    boundWallet: async () => {
      calls.wallets += 1;
      return wallet;
    },
    listOperations: async () => {
      calls.operations += 1;
      return { operations: ops, truncated: opts.truncated ?? false };
    },
    getResultMetaXdr: async () => {
      calls.meta += 1;
      return null;
    },
  };
}

function freshCalls() {
  return { db: 0, wallets: 0, operations: 0, meta: 0 };
}

function createOp(overrides: Partial<ProfileContractsHorizonOp> = {}): ProfileContractsHorizonOp {
  return {
    type: 'invoke_host_function',
    function: 'HostFunctionTypeCreateContract',
    salt: SALT_HEX,
    transactionHash: 'tx1',
    createdAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  };
}

function dbRow(overrides: Partial<DbContractSeed> = {}): DbContractSeed {
  return {
    address: CONTRACT,
    walletId: 'w1',
    network: NETWORK,
    deployerPubkey: DEPLOYER,
    deployTxHash: 'tx1',
    deployedAt: new Date('2026-09-20T12:00:00.000Z'),
    wasmHash: null,
    ...overrides,
  };
}

test('DB rows from several wallets merge newest-first and flag multi-wallet', async () => {
  const calls = freshCalls();
  const db = makeDb(
    [
      dbRow({
        address: `C${'A'.repeat(55)}`,
        walletId: 'w1',
        deployedAt: new Date('2026-09-18T12:00:00.000Z'),
        deployTxHash: 'tx-old',
      }),
      dbRow({
        address: `C${'B'.repeat(55)}`,
        walletId: 'w2',
        deployerPubkey: OTHER_DEPLOYER,
        deployedAt: new Date('2026-09-22T12:00:00.000Z'),
        deployTxHash: 'tx-new',
      }),
      dbRow({
        walletId: 'w1',
        deployedAt: new Date('2026-09-20T12:00:00.000Z'),
        deployTxHash: 'tx-mid',
      }),
    ],
    2,
    calls,
  );

  const res = await getProfileContractsWithDeps('alice', { network: NETWORK, db });

  assert.equal(res.source, 'database');
  assert.deepEqual(
    res.contracts.map((c) => c.deployTxHash),
    ['tx-new', 'tx-mid', 'tx-old'],
  );
  assert.equal(res.contracts[0]?.deployerPubkey, OTHER_DEPLOYER);
  assert.equal(res.multiWallet, true);
  assert.equal(res.truncated, false);
  assert.equal(res.cap, null);
  assert.equal(calls.wallets, 0);
});

test('DB rows on other networks are filtered out', async () => {
  const calls = freshCalls();
  const db = makeDb(
    [
      dbRow({ network: 'mainnet', deployTxHash: 'tx-main' }),
      dbRow({ network: NETWORK, deployTxHash: 'tx-test' }),
    ],
    1,
    calls,
  );

  const res = await getProfileContractsWithDeps('alice', { network: NETWORK, db });

  assert.deepEqual(
    res.contracts.map((c) => c.deployTxHash),
    ['tx-test'],
  );
  assert.equal(res.multiWallet, false);
});

test('reachable DB with no rows is an honest empty list, not a Horizon fallback', async () => {
  const calls = freshCalls();
  const db = makeDb([], 1, calls);

  const res = await getProfileContractsWithDeps('alice', {
    network: NETWORK,
    db,
    horizon: makeHorizon(DEPLOYER, [createOp()], calls),
  });

  assert.deepEqual(res.contracts, []);
  assert.equal(res.source, 'database');
  assert.equal(calls.operations, 0);
});

test('without a DB, create-contract ops resolve through salt derivation', async () => {
  const calls = freshCalls();
  const horizon = makeHorizon(
    DEPLOYER,
    [
      createOp({ transactionHash: 'tx-deploy', createdAt: '2026-09-21T12:00:00.000Z' }),
      createOp({
        function: 'HostFunctionTypeInvokeContract',
        salt: null,
        transactionHash: 'tx-invoke',
      }),
    ],
    calls,
  );

  const res = await getProfileContractsWithDeps('alice', { network: NETWORK, db: noDb, horizon });

  assert.equal(res.source, 'horizon');
  assert.equal(res.contracts.length, 1);
  assert.deepEqual(res.contracts[0], {
    address: CONTRACT,
    deployedAt: '2026-09-21T12:00:00.000Z',
    deployTxHash: 'tx-deploy',
    deployerPubkey: DEPLOYER,
    source: 'horizon',
    wasmHash: null,
  });
  // The non-create op never reaches result-meta decoding.
  assert.equal(calls.meta, 0);
});

test('Horizon truncation is carried through with the cap', async () => {
  const calls = freshCalls();
  const horizon = makeHorizon(DEPLOYER, [createOp()], calls, { truncated: true });

  const res = await getProfileContractsWithDeps('alice', { network: NETWORK, db: noDb, horizon });

  assert.equal(res.truncated, true);
  assert.equal(res.cap, HORIZON_MAX_RECORDS);
  assert.equal(res.contracts.length, 1);
});

test('ops that resolve to no address are skipped', async () => {
  const calls = freshCalls();
  // No salt and no result meta: nothing to derive from.
  const horizon = makeHorizon(DEPLOYER, [createOp({ salt: null, transactionHash: null })], calls);

  const res = await getProfileContractsWithDeps('alice', { network: NETWORK, db: noDb, horizon });

  assert.deepEqual(res.contracts, []);
  assert.equal(res.source, 'horizon');
});

test('no bound wallet means no contracts without touching operations', async () => {
  const calls = freshCalls();
  const horizon = makeHorizon(null, [createOp()], calls);

  const res = await getProfileContractsWithDeps('alice', { network: NETWORK, db: noDb, horizon });

  assert.deepEqual(res.contracts, []);
  assert.equal(res.source, 'none');
  assert.equal(calls.operations, 0);
});

test('invalid handle performs no I/O', async () => {
  const calls = freshCalls();
  const db = makeDb([dbRow()], 1, calls);

  const res = await getProfileContractsWithDeps('not a handle!', {
    network: NETWORK,
    db,
    horizon: makeHorizon(DEPLOYER, [createOp()], calls),
  });

  assert.deepEqual(res.contracts, []);
  assert.equal(res.source, 'none');
  assert.equal(calls.db, 0);
  assert.equal(calls.wallets, 0);
});
