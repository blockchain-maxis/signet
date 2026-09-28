import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runInvocationsWorker,
  extractFootprint,
  extractFunctionName,
  extractChangedKeys,
  extractEventsContractIds,
  extractSourceAccount,
  ledgerEntryToLedgerKey,
  type InvocationsStore,
  type InvocationsContract,
  type ContractInvocationCreate,
  type ContractInvocationUpdate,
  type SorobanInvocationsRpc,
} from './invocations.js';
import { xdr } from '@stellar/stellar-sdk';
import claimFixture from '../../../../packages/fixtures/data/claim-get-transaction.json' with { type: 'json' };
import deployFixture from '../../../../packages/fixtures/data/deploy-get-transaction.json' with { type: 'json' };

function createMockStore(contracts: InvocationsContract[] = []) {
  const contractInvocations: Map<string, ContractInvocationCreate> = new Map();

  const store: InvocationsStore = {
    contract: {
      findMany: async () => contracts,
    },
    contractInvocation: {
      findFirst: async ({ where }) => {
        const matching = Array.from(contractInvocations.values())
          .filter((inv) => inv.contractId === where.contractId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (matching.length === 0) return null;
        return { txHash: matching[0]!.txHash, ledger: matching[0]!.ledger };
      },
      upsert: async ({ where, update, create }) => {
        const existing = contractInvocations.get(where.id);
        if (existing) {
          contractInvocations.set(where.id, {
            ...existing,
            ...update,
          });
        } else {
          contractInvocations.set(where.id, { ...create });
        }
        return contractInvocations.get(where.id);
      },
    },
  };

  return { store, contractInvocations };
}

test('extracts sourceAccount, footprint, functionName, changedKeys, and eventsContractIds correctly from fixtures', () => {
  const claimEnv = xdr.TransactionEnvelope.fromXDR(claimFixture.payload.envelopeXdr, 'base64');
  const claimTx = claimEnv.v1().tx();
  const regAddress = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

  const sourceAccount = extractSourceAccount(claimEnv);
  assert.equal(sourceAccount, 'GCWEY5SG6LEGTI6MJ7BTS5FF22DDBZN3E6BS4AFFB44BNOAE4A5V4PWE');

  const { readOnly, readWrite } = extractFootprint(claimTx);
  assert.equal(readOnly.length, 1);
  assert.equal(readWrite.length, 3);

  const fnName = extractFunctionName(claimTx, regAddress);
  assert.equal(fnName, 'claim');

  const otherFnName = extractFunctionName(claimTx, 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
  assert.equal(otherFnName, null);

  const changed = extractChangedKeys(claimFixture.payload.resultMetaXdr);
  assert.ok(changed !== null);
  assert.equal(changed.length, 6);

  const eventsContractIds = extractEventsContractIds(claimFixture.payload.resultMetaXdr);
  assert.ok(eventsContractIds.includes('CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN'));
  assert.ok(eventsContractIds.includes('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'));
});

test('extractChangedKeys keeps every recognized key even when one change has an unsupported LedgerKey arm', () => {
  // A configSetting entry change has no LedgerKey mapping in ledgerEntryToLedgerKey.
  // One such change anywhere in the transaction must not wipe out the contractData
  // keys already found — `changed: null` is reserved for "meta wasn't available".
  const contractId = Buffer.alloc(32, 1);
  const contractDataEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        contract: xdr.ScAddress.scAddressTypeContract(contractId as unknown as Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0]),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvVoid(),
        ext: new xdr.ExtensionPoint(0),
      }),
    ),
    ext: new xdr.LedgerEntryExt(0),
  });
  const configSettingEntry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: 1,
    data: xdr.LedgerEntryData.configSetting(
      xdr.ConfigSettingEntry.configSettingContractMaxSizeBytes(1000),
    ),
    ext: new xdr.LedgerEntryExt(0),
  });

  const meta = new xdr.TransactionMeta(
    3,
    new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [
        xdr.LedgerEntryChange.ledgerEntryCreated(contractDataEntry),
        xdr.LedgerEntryChange.ledgerEntryCreated(configSettingEntry),
      ],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: null,
    }),
  );

  const changed = extractChangedKeys(meta);
  assert.ok(changed !== null, 'one unsupported arm must not turn the whole result into null');
  assert.equal(changed.length, 1, 'the contractData key is still captured');
});

test('runInvocationsWorker upserts invocations idempotently', async () => {
  const contract: InvocationsContract = {
    id: 'contract-1',
    address: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
    wasmHash: 'abc123wasmhash',
  };
  const { store, contractInvocations } = createMockStore([contract]);

  const mockRpc = {
    getLatestLedger: async () => ({ sequence: 4887004 } as any),
    getEvents: async () => ({
      latestLedger: 4887004,
      events: [
        {
          ledger: claimFixture.payload.ledger,
          txHash: claimFixture.payload.txHash,
        } as any,
      ],
    }),
    getTransaction: async (hash: string) => {
      if (hash === claimFixture.payload.txHash) {
        return claimFixture.payload as any;
      }
      return { status: 'NOT_FOUND' } as any;
    },
  } as unknown as SorobanInvocationsRpc;

  // First run
  const res1 = await runInvocationsWorker(mockRpc, { eventWindowLedgers: 8000 }, store);
  assert.equal(res1.invocationsUpserted, 1);
  assert.equal(contractInvocations.size, 1);

  const record = contractInvocations.get(`${claimFixture.payload.txHash}:0`);
  assert.ok(record);
  assert.equal(record.contractId, 'contract-1');
  assert.equal(record.sourceAccount, 'GCWEY5SG6LEGTI6MJ7BTS5FF22DDBZN3E6BS4AFFB44BNOAE4A5V4PWE');
  assert.equal(record.function, 'claim');
  assert.equal(record.successful, true);
  assert.equal(record.wasmHash, 'abc123wasmhash');
  assert.equal(record.readOnly.length, 1);
  assert.equal(record.readWrite.length, 3);
  assert.ok(Array.isArray(record.changed) && record.changed.length === 6);

  // Second run (idempotency)
  const res2 = await runInvocationsWorker(mockRpc, { eventWindowLedgers: 8000 }, store);
  assert.equal(contractInvocations.size, 1);
});

test('runInvocationsWorker respects cursor and skips already scanned ledgers', async () => {
  const contract: InvocationsContract = {
    id: 'contract-1',
    address: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
    wasmHash: null,
  };
  const { store } = createMockStore([contract]);

  // Pre-seed an invocation at latest ledger 4887004
  await store.contractInvocation.upsert({
    where: { id: 'existing-tx:0' },
    update: {} as any,
    create: {
      id: 'existing-tx:0',
      contractId: 'contract-1',
      txHash: 'existing-tx',
      ledger: 4887004,
      createdAt: new Date(),
      sourceAccount: 'GCWEY...',
      function: 'claim',
      successful: true,
      wasmHash: null,
      readOnly: [],
      readWrite: [],
      changed: null,
      eventsContractIds: [],
    },
  });

  let eventsCalled = false;
  const mockRpc = {
    getLatestLedger: async () => ({ sequence: 4887004 } as any),
    getEvents: async () => {
      eventsCalled = true;
      return { latestLedger: 4887004, events: [] };
    },
    getTransaction: async () => ({ status: 'NOT_FOUND' } as any),
  } as unknown as SorobanInvocationsRpc;

  const res = await runInvocationsWorker(mockRpc, { eventWindowLedgers: 8000 }, store);
  assert.equal(res.invocationsUpserted, 0);
  // startLedger is 4887005 > 4887004, so getEvents is skipped
  assert.equal(eventsCalled, false);
});

test('runInvocationsWorker skips expired hash when RPC returns NOT_FOUND', async () => {
  const contract: InvocationsContract = {
    id: 'contract-1',
    address: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
    wasmHash: null,
  };
  const { store, contractInvocations } = createMockStore([contract]);

  const mockRpc = {
    getLatestLedger: async () => ({ sequence: 4887004 } as any),
    getEvents: async () => ({
      latestLedger: 4887004,
      events: [{ ledger: 4880000, txHash: 'expired-tx-hash' } as any],
    }),
    getTransaction: async () => ({ status: 'NOT_FOUND' } as any),
  } as unknown as SorobanInvocationsRpc;

  const res = await runInvocationsWorker(mockRpc, { eventWindowLedgers: 8000 }, store);
  assert.equal(res.invocationsUpserted, 0);
  assert.equal(contractInvocations.size, 0);
});

test('runInvocationsWorker handles malformed XDR gracefully by logging and skipping', async () => {
  const contract: InvocationsContract = {
    id: 'contract-1',
    address: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
    wasmHash: null,
  };
  const { store, contractInvocations } = createMockStore([contract]);

  const mockRpc = {
    getLatestLedger: async () => ({ sequence: 4887004 } as any),
    getEvents: async () => ({
      latestLedger: 4887004,
      events: [{ ledger: 4880000, txHash: 'malformed-tx-hash' } as any],
    }),
    getTransaction: async () =>
      ({
        status: 'SUCCESS',
        txHash: 'malformed-tx-hash',
        ledger: 4880000,
        createdAt: '1790413437',
        envelopeXdr: 'INVALID_BASE64_NOT_XDR',
        resultMetaXdr: 'INVALID_META',
      }) as any,
  } as unknown as SorobanInvocationsRpc;

  // Should not throw, should log warning and continue
  const res = await runInvocationsWorker(mockRpc, { eventWindowLedgers: 8000 }, store);
  assert.equal(res.invocationsUpserted, 0);
  assert.equal(contractInvocations.size, 0);
});
