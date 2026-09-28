import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Networks, StrKey, xdr } from '@stellar/stellar-sdk';
import {
  attributeContractWithDeps,
  decodeContractAddressFromMeta,
  type AttributionDb,
  type AttributionDbRow,
  type AttributionHorizon,
  type AttributionHorizonOp,
} from './contract-attribution.ts';
import { HORIZON_MAX_RECORDS } from './server/horizon.ts';

// Chain-confirmed create-contract vector (see contract-address.test.ts): the
// deployer, salt and passphrase below reproduce the exact contract address
// the testnet network assigned (tx
// ea7a9098e63e588d81bb3aeff8c09fe2d82767228ae99a04f3039de915e753a2).
const DEPLOYER = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const SALT_HEX = '075afa7ea513abbddc97610bbef3276c89be0a040c3e914920dd7efb424a6ad6';
const CONTRACT = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';
const NETWORK = 'testnet' as const;

type FakeWallet = { id: string; pubkey: string; isPrimary: boolean };

function makeDb(
  profiles: Record<string, FakeWallet[]>,
  contracts: Array<{
    address: string;
    walletId: string;
    network: string;
    deployerPubkey: string;
    deployTxHash: string;
    deployedAt: Date;
    wasmHash: string | null;
  }>,
  calls: { db: number },
): AttributionDb {
  return {
    findContract: async ({ address, handle, network }): Promise<AttributionDbRow | null> => {
      calls.db += 1;
      const wallets = profiles[handle.toLowerCase()] ?? [];
      const ids = new Set(wallets.map((w) => w.id));
      const row = contracts.find(
        (c) => c.address === address && c.network === network && ids.has(c.walletId),
      );
      if (!row) return null;
      const wallet = wallets.find((w) => w.id === row.walletId)!;
      return { ...row, walletPubkey: wallet.pubkey };
    },
  };
}

/** A database that is entirely absent: unset DATABASE_URL or unreachable. */
const noDb: AttributionDb = {
  findContract: async () => undefined,
};

function makeHorizon(
  wallets: Record<string, string[]>,
  ops: Record<string, AttributionHorizonOp[]>,
  calls: { wallets: number; operations: number; meta: number },
  opts: { truncated?: boolean; throwOnOperations?: boolean; meta?: Record<string, string> } = {},
): AttributionHorizon {
  return {
    listWallets: async (handle: string) => {
      calls.wallets += 1;
      return wallets[handle] ?? [];
    },
    listOperations: async (wallet: string) => {
      calls.operations += 1;
      if (opts.throwOnOperations) throw new Error('horizon down');
      return { operations: ops[wallet] ?? [], truncated: opts.truncated ?? false };
    },
    getResultMetaXdr: async (txHash: string) => {
      calls.meta += 1;
      return opts.meta?.[txHash] ?? null;
    },
  };
}

function freshCalls() {
  return { db: 0, wallets: 0, operations: 0, meta: 0 };
}

/** Synthetic v3 result meta returning the given contract address. */
function buildV3Meta(contractAddress: string): string {
  const contractId = StrKey.decodeContract(contractAddress);
  const scAddress = xdr.ScAddress.scAddressTypeContract(
    contractId as unknown as Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0],
  );
  const sorobanMeta = new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events: [],
    returnValue: xdr.ScVal.scvAddress(scAddress),
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

/** Synthetic v4 result meta returning the given contract address. */
function buildV4Meta(contractAddress: string): string {
  const contractId = StrKey.decodeContract(contractAddress);
  const scAddress = xdr.ScAddress.scAddressTypeContract(
    contractId as unknown as Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0],
  );
  const sorobanMeta = new xdr.SorobanTransactionMetaV2({
    ext: new xdr.SorobanTransactionMetaExt(0),
    returnValue: xdr.ScVal.scvAddress(scAddress),
  });
  const v4 = new xdr.TransactionMetaV4({
    ext: new xdr.ExtensionPoint(0),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta,
    events: [],
    diagnosticEvents: [],
  });
  return new xdr.TransactionMeta(4, v4).toXDR('base64');
}

function createOp(overrides: Partial<AttributionHorizonOp> = {}): AttributionHorizonOp {
  return {
    type: 'invoke_host_function',
    function: 'HostFunctionTypeCreateContract',
    createdAt: '2026-09-20T12:00:00.000Z',
    ...overrides,
  };
}

test('DB row owned by the primary wallet attributes with source database', async () => {
  const calls = freshCalls();
  const wallet = { id: 'w1', pubkey: DEPLOYER, isPrimary: true };
  const db = makeDb(
    { alice: [wallet] },
    [
      {
        address: CONTRACT,
        walletId: 'w1',
        network: NETWORK,
        deployerPubkey: DEPLOYER,
        deployTxHash: 'tx1',
        deployedAt: new Date('2026-09-20T12:00:00.000Z'),
        wasmHash: 'abc123',
      },
    ],
    calls,
  );
  const horizon = makeHorizon({ alice: [DEPLOYER] }, {}, calls);

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db,
    horizon,
  });

  assert.deepEqual(res, {
    status: 'attributed',
    source: 'database',
    contract: {
      address: CONTRACT,
      network: NETWORK,
      deployerPubkey: DEPLOYER,
      deployTxHash: 'tx1',
      deployedAt: '2026-09-20T12:00:00.000Z',
      wasmHash: 'abc123',
      walletId: 'w1',
    },
  });
  assert.equal(calls.operations, 0);
});

test('DB row owned by a non-primary wallet attributes too', async () => {
  const calls = freshCalls();
  const db = makeDb(
    {
      alice: [
        { id: 'w1', pubkey: DEPLOYER, isPrimary: true },
        { id: 'w2', pubkey: `G${'B'.repeat(55)}`, isPrimary: false },
      ],
    },
    [
      {
        address: CONTRACT,
        walletId: 'w2',
        network: NETWORK,
        deployerPubkey: `G${'B'.repeat(55)}`,
        deployTxHash: 'tx2',
        deployedAt: new Date('2026-09-21T12:00:00.000Z'),
        wasmHash: null,
      },
    ],
    calls,
  );

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db,
    horizon: makeHorizon({}, {}, calls),
  });

  assert.deepEqual(res, {
    status: 'attributed',
    source: 'database',
    contract: {
      address: CONTRACT,
      network: NETWORK,
      deployerPubkey: `G${'B'.repeat(55)}`,
      deployTxHash: 'tx2',
      deployedAt: '2026-09-21T12:00:00.000Z',
      wasmHash: null,
      walletId: 'w2',
    },
  });
});

test("DB row owned by a different profile's wallet does not attribute", async () => {
  const calls = freshCalls();
  const db = makeDb(
    {
      alice: [{ id: 'w1', pubkey: DEPLOYER, isPrimary: true }],
      bob: [{ id: 'w9', pubkey: `G${'C'.repeat(55)}`, isPrimary: true }],
    },
    [
      {
        address: CONTRACT,
        walletId: 'w9',
        network: NETWORK,
        deployerPubkey: `G${'C'.repeat(55)}`,
        deployTxHash: 'tx9',
        deployedAt: new Date('2026-09-21T12:00:00.000Z'),
        wasmHash: null,
      },
    ],
    calls,
  );
  const horizon = makeHorizon({ alice: [DEPLOYER] }, {}, calls);

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db,
    horizon,
  });

  assert.deepEqual(res, { status: 'not-attributed' });
  assert.equal(calls.operations, 0);
});

test('DB row on another network does not attribute', async () => {
  const calls = freshCalls();
  const db = makeDb(
    { alice: [{ id: 'w1', pubkey: DEPLOYER, isPrimary: true }] },
    [
      {
        address: CONTRACT,
        walletId: 'w1',
        network: 'mainnet',
        deployerPubkey: DEPLOYER,
        deployTxHash: 'tx1',
        deployedAt: new Date('2026-09-20T12:00:00.000Z'),
        wasmHash: null,
      },
    ],
    calls,
  );

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db,
    horizon: makeHorizon({ alice: [DEPLOYER] }, {}, calls),
  });

  assert.deepEqual(res, { status: 'not-attributed' });
  assert.equal(calls.operations, 0);
});

test('reachable DB with no row misses without touching Horizon', async () => {
  const calls = freshCalls();
  const db = makeDb({ alice: [{ id: 'w1', pubkey: DEPLOYER, isPrimary: true }] }, [], calls);
  const horizon = makeHorizon({ alice: [DEPLOYER] }, {}, calls);

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db,
    horizon,
  });

  assert.deepEqual(res, { status: 'not-attributed' });
  assert.equal(calls.db, 1);
  assert.equal(calls.wallets, 0);
  assert.equal(calls.operations, 0);
  assert.equal(calls.meta, 0);
});

test('no DB plus a Horizon create op deriving to the address attributes via horizon', async () => {
  const calls = freshCalls();
  const horizon = makeHorizon(
    { alice: [DEPLOYER] },
    {
      [DEPLOYER]: [
        createOp({ address: DEPLOYER, salt: SALT_HEX, transactionHash: 'tx1' }),
      ],
    },
    calls,
  );

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db: noDb,
    horizon,
  });

  assert.deepEqual(res, {
    status: 'attributed',
    source: 'horizon',
    contract: {
      address: CONTRACT,
      network: NETWORK,
      deployerPubkey: DEPLOYER,
      deployTxHash: 'tx1',
      deployedAt: '2026-09-20T12:00:00.000Z',
      wasmHash: null,
    },
  });
  // Derived straight from the record's address/salt: no tx fetch needed.
  assert.equal(calls.meta, 0);
});

test('no DB plus a capped Horizon walk with no match misses with capped true', async () => {
  const calls = freshCalls();
  const ops: AttributionHorizonOp[] = Array.from(
    { length: HORIZON_MAX_RECORDS + 5 },
    (_, i) => ({
      type: 'payment',
      createdAt: '2026-09-20T12:00:00.000Z',
      transactionHash: `tx${i}`,
    }),
  );
  const horizon = makeHorizon({ alice: [DEPLOYER] }, { [DEPLOYER]: ops }, calls);

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db: noDb,
    horizon,
  });

  assert.deepEqual(res, { status: 'not-attributed', capped: true });
});

test('no DB plus a throwing Horizon fetcher is unavailable', async () => {
  const calls = freshCalls();
  const horizon = makeHorizon({ alice: [DEPLOYER] }, {}, calls, { throwOnOperations: true });

  const res = await attributeContractWithDeps('alice', CONTRACT, {
    network: NETWORK,
    db: noDb,
    horizon,
  });

  assert.deepEqual(res, { status: 'unavailable' });
});

test('malformed handle or address is invalid with no I/O at all', async () => {
  const calls = freshCalls();
  const db = makeDb({ alice: [{ id: 'w1', pubkey: DEPLOYER, isPrimary: true }] }, [], calls);
  const horizon = makeHorizon({ alice: [DEPLOYER] }, {}, calls);

  assert.deepEqual(
    await attributeContractWithDeps('has space', CONTRACT, { network: NETWORK, db, horizon }),
    { status: 'invalid' },
  );
  assert.deepEqual(
    await attributeContractWithDeps('alice', DEPLOYER, { network: NETWORK, db, horizon }),
    { status: 'invalid' },
  );
  assert.deepEqual(calls, { db: 0, wallets: 0, operations: 0, meta: 0 });
});

test('a v4 result-meta fixture decodes the same as a v3 one through the tx path', async () => {
  for (const build of [buildV3Meta, buildV4Meta]) {
    const calls = freshCalls();
    const meta = build(CONTRACT);
    // Sanity: the shared decoder agrees with the module's own verdict.
    assert.equal(decodeContractAddressFromMeta(meta).ok, true);
    const horizon = makeHorizon(
      { alice: [DEPLOYER] },
      { [DEPLOYER]: [createOp({ transactionHash: 'txv' })] },
      calls,
      { meta: { txv: meta } },
    );

    const res = await attributeContractWithDeps('alice', CONTRACT, {
      network: NETWORK,
      db: noDb,
      horizon,
    });

    assert.deepEqual(res, {
      status: 'attributed',
      source: 'horizon',
      contract: {
        address: CONTRACT,
        network: NETWORK,
        deployerPubkey: DEPLOYER,
        deployTxHash: 'txv',
        deployedAt: '2026-09-20T12:00:00.000Z',
        wasmHash: null,
      },
    });
    assert.equal(calls.meta, 1);
  }
});
