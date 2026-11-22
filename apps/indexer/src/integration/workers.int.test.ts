import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { PrismaClient, Prisma } from '@signet/db';
import { xdr, StrKey, type Horizon } from '@stellar/stellar-sdk';
import claimFixture from '../../../../packages/fixtures/data/claim-get-transaction.json' with { type: 'json' };
import { runDeploymentWorker } from '../workers/deployment.js';
import { runInvocationsWorker, type SorobanInvocationsRpc } from '../workers/invocations.js';
import { runActivityWorker } from '../workers/activity.js';
import { runPruningWorker } from '../workers/prune.js';
import type { ReadExecutable } from '../contract-executable.js';

const dbUrl = process.env.INDEXER_TEST_DATABASE_URL;
const shouldRun = Boolean(dbUrl);

test('Indexer workers integration with real migrated Postgres', { skip: !shouldRun }, async (t) => {
  const prisma = new PrismaClient({
    datasources: { db: { url: dbUrl } },
    log: ['error'],
  });

  before(async () => {
    // Ensure migrations are deployed against the test database
    try {
      execSync('pnpm db:deploy', {
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: 'ignore',
      });
    } catch {
      // Migrations may already be deployed in CI
    }
  });

  beforeEach(async () => {
    // Clean all indexer-related tables in dependency order
    await prisma.contractSnapshot.deleteMany();
    await prisma.contractInvocation.deleteMany();
    await prisma.contractWasmVersion.deleteMany();
    await prisma.operation.deleteMany();
    await prisma.pairingState.deleteMany();
    await prisma.contract.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.profile.deleteMany();
    await prisma.indexerCursor.deleteMany();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  const CONTRACT_ONE = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
  const WASM_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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

  await t.test('deployment worker creates a Contract and a ContractWasmVersion', async () => {
    const profile = await prisma.profile.create({
      data: { handle: 'deployer-alice' },
    });
    const wallet = await prisma.wallet.create({
      data: {
        pubkey: 'GBNTPIH54YJW4SFUIF2L7PBARVQZVSRKVE72OKN5IZC2CXMAEQI3VWCA',
        profileId: profile.id,
        source: 'onchain',
      },
    });

    const horizon = {
      operations: () => ({
        forAccount: () => ({
          order: () => ({
            limit: () => ({
              cursor: () => ({
                call: async () => ({
                  records: [
                    {
                      type: 'invoke_host_function',
                      function: 'HostFunctionTypeCreateContract',
                      transaction_hash: 'deploy-tx-1',
                      paging_token: 'tok-1',
                    },
                  ],
                  next: async () => ({ records: [], next: async () => ({ records: [] }) }),
                }),
              }),
              call: async () => ({
                records: [
                  {
                    type: 'invoke_host_function',
                    function: 'HostFunctionTypeCreateContract',
                    transaction_hash: 'deploy-tx-1',
                    paging_token: 'tok-1',
                  },
                ],
                next: async () => ({ records: [], next: async () => ({ records: [] }) }),
              }),
            }),
          }),
        }),
      }),
      transactions: () => ({
        transaction: () => ({
          call: async () => ({
            result_meta_xdr: contractCreationMetaXdr(CONTRACT_ONE),
            ledger_attr: 100,
            created_at: '2026-01-01T00:00:00Z',
          }),
        }),
      }),
    } as unknown as Horizon.Server;

    const executableReader: ReadExecutable = async () => ({
      type: 'wasm',
      wasmHash: WASM_HASH,
    });

    const result = await runDeploymentWorker(
      horizon,
      { network: 'testnet' } as any,
      prisma,
      executableReader,
    );

    assert.equal(result.contractsFound, 1);

    const contract = await prisma.contract.findUnique({
      where: { address: CONTRACT_ONE },
    });
    assert.ok(contract, 'Contract row should be created in Postgres');
    assert.equal(contract.walletId, wallet.id);
    assert.equal(contract.wasmHash, WASM_HASH);
    assert.equal(contract.executableType, 'wasm');

    const wasmVersion = await prisma.contractWasmVersion.findUnique({
      where: {
        contractId_wasmHash: {
          contractId: contract.id,
          wasmHash: WASM_HASH,
        },
      },
    });
    assert.ok(wasmVersion, 'ContractWasmVersion row should be created in Postgres');
    assert.equal(wasmVersion.contractId, contract.id);
    assert.equal(wasmVersion.wasmHash, WASM_HASH);
    assert.equal(wasmVersion.observedLedger, 100);
  });

  await t.test(
    'invocations worker stores missing-meta invocation as SQL NULL in changed column',
    async () => {
      const profile = await prisma.profile.create({
        data: { handle: 'caller-bob' },
      });
      const wallet = await prisma.wallet.create({
        data: {
          pubkey: 'GCWEY5SG6LEGTI6MJ7BTS5FF22DDBZN3E6BS4AFFB44BNOAE4A5V4PWE',
          profileId: profile.id,
          source: 'onchain',
        },
      });
      const contract = await prisma.contract.create({
        data: {
          address: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
          walletId: wallet.id,
          deployerPubkey: wallet.pubkey,
          deployedAt: new Date(),
          deployTxHash: 'init-deploy-tx',
          network: 'testnet',
        },
      });

      // Payload with missing resultMetaXdr
      const txPayload = {
        ...claimFixture.payload,
        resultMetaXdr: null,
      };

      const mockRpc = {
        getLatestLedger: async () => ({ sequence: 4887010 } as any),
        getEvents: async () => ({
          latestLedger: 4887010,
          events: [
            {
              ledger: txPayload.ledger,
              txHash: txPayload.txHash,
            } as any,
          ],
        }),
        getTransaction: async (hash: string) => {
          if (hash === txPayload.txHash) {
            return txPayload as any;
          }
          return { status: 'NOT_FOUND' } as any;
        },
      } as unknown as SorobanInvocationsRpc;

      const res = await runInvocationsWorker(mockRpc, { eventWindowLedgers: 8000 }, prisma);
      assert.equal(res.invocationsUpserted, 1);

      const inv = await prisma.contractInvocation.findUnique({
        where: { id: `${txPayload.txHash}:0` },
      });
      assert.ok(inv, 'Invocation row should be created');
      assert.equal(inv.contractId, contract.id);
      assert.equal(inv.changed, null, 'Prisma reads SQL NULL as javascript null');

      // Verify via raw SQL that the column is truly SQL NULL in PostgreSQL
      const rawRows = await prisma.$queryRawUnsafe<Array<{ changed: unknown }>>(
        'SELECT "changed" FROM "ContractInvocation" WHERE id = $1',
        `${txPayload.txHash}:0`,
      );
      assert.equal(rawRows.length, 1);
      assert.equal(rawRows[0]!.changed, null, 'Postgres column must be SQL NULL');
    },
  );

  await t.test('activity worker writes a contract snapshot', async () => {
    const profile = await prisma.profile.create({
      data: { handle: 'active-user' },
    });
    const wallet = await prisma.wallet.create({
      data: {
        pubkey: 'GACTIVEWALLET111111111111111111111111111111111111111111111',
        profileId: profile.id,
        source: 'onchain',
      },
    });
    const contract = await prisma.contract.create({
      data: {
        address: 'CACTIVECONTRACT111111111111111111111111111111111111111111',
        walletId: wallet.id,
        deployerPubkey: wallet.pubkey,
        deployedAt: new Date(),
        deployTxHash: 'active-deploy-tx',
        network: 'testnet',
      },
    });
    await prisma.contractInvocation.create({
      data: {
        id: 'active-tx:0',
        contractId: contract.id,
        txHash: 'active-tx',
        ledger: 1000,
        createdAt: new Date(),
        sourceAccount: wallet.pubkey,
        function: 'hello',
        successful: true,
        readOnly: [],
        readWrite: [],
        changed: Prisma.DbNull,
        eventsContractIds: [],
      },
    });

    const res = await runActivityWorker(prisma, { network: 'testnet' } as any);
    assert.equal(res.snapshotsWritten, 1);

    const snapshot = await prisma.contractSnapshot.findFirst({
      where: { contractId: contract.id },
    });
    assert.ok(snapshot, 'ContractSnapshot row should be created');
    assert.equal(snapshot.contractId, contract.id);
    assert.equal(snapshot.txCountTotal, 1);
  });

  await t.test('pruning worker deletes old rows', async () => {
    const profile = await prisma.profile.create({
      data: { handle: 'prune-user' },
    });
    const wallet = await prisma.wallet.create({
      data: {
        pubkey: 'GPRUNEWALLET1111111111111111111111111111111111111111111111',
        profileId: profile.id,
        source: 'onchain',
      },
    });
    const contract = await prisma.contract.create({
      data: {
        address: 'CPRUNECONTRACT1111111111111111111111111111111111111111111',
        walletId: wallet.id,
        deployerPubkey: wallet.pubkey,
        deployedAt: new Date(),
        deployTxHash: 'prune-deploy-tx',
        network: 'testnet',
      },
    });

    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days old
    const recentDate = new Date(); // now

    // Create old and recent operations
    await prisma.operation.create({
      data: {
        id: 'old-op',
        walletId: wallet.id,
        type: 'invoke_host_function',
        createdAt: oldDate,
      },
    });
    await prisma.operation.create({
      data: {
        id: 'recent-op',
        walletId: wallet.id,
        type: 'invoke_host_function',
        createdAt: recentDate,
      },
    });

    // Create old and recent snapshots
    const oldSnapshot = await prisma.contractSnapshot.create({
      data: {
        contractId: contract.id,
        capturedAt: oldDate,
      },
    });
    const recentSnapshot = await prisma.contractSnapshot.create({
      data: {
        contractId: contract.id,
        capturedAt: recentDate,
      },
    });

    const pruneConfig = {
      operationsRetentionDays: 90,
      snapshotsRetentionDays: 30,
      invocationsMaxPerContract: 1000,
    } as any;

    const res = await runPruningWorker(prisma, pruneConfig);
    assert.equal(res.opsPruned, 1);
    assert.equal(res.snapshotsPruned, 1);

    const oldOpRow = await prisma.operation.findUnique({ where: { id: 'old-op' } });
    assert.equal(oldOpRow, null, 'Old operation must be pruned');

    const recentOpRow = await prisma.operation.findUnique({ where: { id: 'recent-op' } });
    assert.ok(recentOpRow, 'Recent operation must remain');

    const oldSnapRow = await prisma.contractSnapshot.findUnique({ where: { id: oldSnapshot.id } });
    assert.equal(oldSnapRow, null, 'Old snapshot must be pruned');

    const recentSnapRow = await prisma.contractSnapshot.findUnique({
      where: { id: recentSnapshot.id },
    });
    assert.ok(recentSnapRow, 'Recent snapshot must remain');
  });
});
