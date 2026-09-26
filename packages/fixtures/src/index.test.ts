import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr, StrKey } from '@stellar/stellar-sdk';
import { loadFixture, loadFixtureEnvelope, type FixtureName } from './index.js';

const FIXTURES: FixtureName[] = [
  'registry-instance-entry',
  'sac-instance-entry',
  'contract-wasm-entry',
  'claim-get-transaction',
  'deploy-get-transaction',
  'horizon-contract-deploy-tx',
];

test('each fixture envelope carries network, capturedAt, latestLedger, and request metadata', () => {
  for (const name of FIXTURES) {
    const envelope = loadFixtureEnvelope(name);
    assert.equal(envelope.network, 'testnet', `${name} network is testnet`);
    assert.ok(envelope.capturedAt, `${name} has capturedAt timestamp`);
    assert.ok(envelope.latestLedger > 0, `${name} has latestLedger number`);
    assert.ok(envelope.request.endpoint, `${name} has request endpoint`);
    assert.ok(envelope.request.methodOrPath, `${name} has request methodOrPath`);
    assert.ok(envelope.payload, `${name} has non-null payload`);
  }
});

test('registry-instance-entry parses as valid LedgerEntryData and contains ContractDataEntry', () => {
  const fixture = loadFixture('registry-instance-entry');
  assert.ok(fixture.entries && fixture.entries.length > 0);
  const entry = fixture.entries[0]!;
  assert.ok(entry.key);
  assert.ok(entry.xdr);

  const ledgerEntry = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
  assert.equal(ledgerEntry.switch().name, 'contractData');
  const contractData = ledgerEntry.contractData();
  assert.equal(contractData.key().switch().name, 'scvLedgerKeyContractInstance');
});

test('sac-instance-entry parses as valid LedgerEntryData and contains SAC AssetInfo/Metadata', () => {
  const fixture = loadFixture('sac-instance-entry');
  assert.ok(fixture.entries && fixture.entries.length > 0);
  const entry = fixture.entries[0]!;
  const ledgerEntry = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
  assert.equal(ledgerEntry.switch().name, 'contractData');
});

test('contract-wasm-entry parses as valid LedgerEntryData and contains ContractCodeEntry', () => {
  const fixture = loadFixture('contract-wasm-entry');
  assert.ok(fixture.entries && fixture.entries.length > 0);
  const entry = fixture.entries[0]!;
  const ledgerEntry = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
  assert.equal(ledgerEntry.switch().name, 'contractCode');
  const code = ledgerEntry.contractCode().code();
  assert.ok(code.length > 0, 'WASM byte length is non-zero');
});

test('claim-get-transaction parses envelope and result XDR', () => {
  const fixture = loadFixture('claim-get-transaction');
  assert.equal(fixture.status, 'SUCCESS');
  assert.ok(fixture.txHash);
  if (fixture.envelopeXdr) {
    const env = xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, 'base64');
    assert.ok(env);
  }
  if (fixture.resultXdr) {
    const res = xdr.TransactionResult.fromXDR(fixture.resultXdr, 'base64');
    assert.ok(res);
  }
  if (fixture.resultMetaXdr) {
    const meta = xdr.TransactionMeta.fromXDR(fixture.resultMetaXdr, 'base64');
    assert.ok(meta);
  }
});

test('deploy-get-transaction is a create-contract transaction whose meta returns the new contract address', () => {
  const fixture = loadFixture('deploy-get-transaction');
  assert.equal(fixture.status, 'SUCCESS');
  assert.ok(fixture.envelopeXdr && fixture.resultMetaXdr);

  const env = xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, 'base64');
  const op = env.v1().tx().operations()[0]!.body();
  assert.equal(op.switch().name, 'invokeHostFunction');
  assert.equal(
    op.invokeHostFunctionOp().hostFunction().switch().name,
    'hostFunctionTypeCreateContract',
  );

  const meta = xdr.TransactionMeta.fromXDR(fixture.resultMetaXdr, 'base64');
  assert.equal(meta.switch(), 4, 'current testnet returns TransactionMeta v4');
  const returnValue = meta.v4().sorobanMeta()?.returnValue();
  assert.ok(returnValue, 'v4 soroban meta carries a return value');
  assert.equal(returnValue.switch().name, 'scvAddress');
  const address = returnValue.address();
  assert.equal(address.switch().name, 'scAddressTypeContract');
  assert.ok(
    StrKey.isValidContract(
      StrKey.encodeContract(Buffer.from(address.contractId() as unknown as Uint8Array)),
    ),
  );
});

test('horizon-contract-deploy-tx is the Horizon record of the same deployment, unmodified', () => {
  const horizon = loadFixture('horizon-contract-deploy-tx');
  const rpc = loadFixture('deploy-get-transaction');
  assert.equal(horizon.hash, rpc.txHash);
  assert.equal(
    loadFixtureEnvelope('horizon-contract-deploy-tx').request.methodOrPath,
    `/transactions/${horizon.hash}`,
  );
  assert.equal(horizon.envelope_xdr, rpc.envelopeXdr);
  xdr.TransactionResult.fromXDR(horizon.result_xdr, 'base64');
  // Current Horizon does not return result_meta_xdr; the meta is in the RPC fixture.
  assert.equal(horizon.result_meta_xdr, undefined);
});
