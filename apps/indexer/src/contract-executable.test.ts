import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contract, StrKey, xdr } from '@stellar/stellar-sdk';
import { loadFixture, type GetLedgerEntriesResult } from '@signet/fixtures';
import {
  createContractExecutableReader,
  decodeInstanceExecutable,
  type LedgerEntriesServer,
} from './contract-executable.ts';

// Recorded from testnet by packages/fixtures (#413) — never hand-edited.
const REGISTRY_CONTRACT = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const REGISTRY_WASM_HASH = '936996c74b7d383c56ec174857b15927cdd29478c6909da332b4dec8b67335fe';
const XLM_SAC_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** The raw `{key, xdr}` pairs RPC returns, as recorded in the fixture. */
function instanceEntry(name: 'registry-instance-entry' | 'sac-instance-entry') {
  return (loadFixture(name) as GetLedgerEntriesResult).entries ?? [];
}

function footprint(address: string): xdr.LedgerKey {
  return new Contract(address).getFootprint();
}

test('the recorded registry instance entry decodes to its real WASM hash', () => {
  assert.deepEqual(
    decodeInstanceExecutable(
      instanceEntry('registry-instance-entry'),
      footprint(REGISTRY_CONTRACT),
    ),
    {
      type: 'wasm',
      wasmHash: REGISTRY_WASM_HASH,
    },
  );
});

test('the recorded SAC instance entry decodes as a Stellar Asset Contract', () => {
  assert.deepEqual(
    decodeInstanceExecutable(instanceEntry('sac-instance-entry'), footprint(XLM_SAC_CONTRACT)),
    {
      type: 'stellar_asset',
    },
  );
});

test('an archived instance — no entry returned for the requested key — reads as null', () => {
  assert.equal(decodeInstanceExecutable([], footprint(REGISTRY_CONTRACT)), null);
});

test('an entry under a different key is not mistaken for the requested contract', () => {
  assert.equal(
    decodeInstanceExecutable(instanceEntry('registry-instance-entry'), footprint(XLM_SAC_CONTRACT)),
    null,
  );
});

test('the SDK’s decoded entry form decodes the same as the raw one', () => {
  const raw = instanceEntry('registry-instance-entry')[0]!;
  assert.deepEqual(
    decodeInstanceExecutable(
      [
        {
          key: xdr.LedgerKey.fromXDR(raw.key, 'base64'),
          val: xdr.LedgerEntryData.fromXDR(raw.xdr, 'base64'),
        },
      ],
      footprint(REGISTRY_CONTRACT),
    ),
    { type: 'wasm', wasmHash: REGISTRY_WASM_HASH },
  );
});

test('a val that is not a contract instance has no executable', () => {
  const raw = instanceEntry('registry-instance-entry')[0]!;
  const notAnInstance = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      contract: xdr.ScAddress.scAddressTypeContract(
        StrKey.decodeContract(REGISTRY_CONTRACT) as never,
      ),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvU32(7),
      ext: new xdr.ExtensionPoint(0),
    }),
  );
  assert.equal(
    decodeInstanceExecutable(
      [{ key: raw.key, xdr: notAnInstance.toXDR('base64') }],
      footprint(REGISTRY_CONTRACT),
    ),
    null,
  );
});

test('a malformed entry XDR reads as null rather than throwing', () => {
  const raw = instanceEntry('registry-instance-entry')[0]!;
  assert.equal(
    decodeInstanceExecutable(
      [{ key: raw.key, xdr: 'not-valid-xdr' }],
      footprint(REGISTRY_CONTRACT),
    ),
    null,
  );
});

test('the reader asks RPC for the contract instance footprint of the address', async () => {
  const calls: xdr.LedgerKey[][] = [];
  const server = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys);
      return { latestLedger: 1, entries: instanceEntry('registry-instance-entry') } as never;
    },
  } as unknown as LedgerEntriesServer;

  const executable = await createContractExecutableReader(server)(REGISTRY_CONTRACT);

  assert.deepEqual(executable, { type: 'wasm', wasmHash: REGISTRY_WASM_HASH });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.map((k) => k.toXDR('base64')),
    [footprint(REGISTRY_CONTRACT).toXDR('base64')],
  );
});

test('an RPC failure propagates, so the worker can log the cause', async () => {
  const server = {
    getLedgerEntries: async () => {
      throw new Error('soroban rpc unreachable');
    },
  } as unknown as LedgerEntriesServer;

  await assert.rejects(createContractExecutableReader(server)(REGISTRY_CONTRACT), /unreachable/);
});

test('an unparseable address propagates too — it is never a silent null hash', async () => {
  let called = false;
  const server = {
    getLedgerEntries: async () => {
      called = true;
      return { latestLedger: 1, entries: [] } as never;
    },
  } as unknown as LedgerEntriesServer;

  await assert.rejects(createContractExecutableReader(server)('not-a-contract-address'));
  assert.equal(called, false, 'no request is even attempted');
});
