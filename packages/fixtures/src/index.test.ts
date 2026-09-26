import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr } from '@stellar/stellar-sdk';
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

test('deploy-get-transaction parses envelope, result, and meta XDR', () => {
  const fixture = loadFixture('deploy-get-transaction');
  assert.equal(fixture.status, 'SUCCESS');
  assert.ok(fixture.txHash);
  if (fixture.envelopeXdr) {
    const env = xdr.TransactionEnvelope.fromXDR(fixture.envelopeXdr, 'base64');
    assert.ok(env);
  }
  if (fixture.resultMetaXdr) {
    const meta = xdr.TransactionMeta.fromXDR(fixture.resultMetaXdr, 'base64');
    assert.ok(meta);
  }
});

test('horizon-contract-deploy-tx parses envelope_xdr, result_xdr, and result_meta_xdr', () => {
  const fixture = loadFixture('horizon-contract-deploy-tx');
  assert.ok(fixture.hash);
  assert.ok(fixture.envelope_xdr);
  const env = xdr.TransactionEnvelope.fromXDR(fixture.envelope_xdr, 'base64');
  assert.ok(env);
  if (fixture.result_xdr) {
    const res = xdr.TransactionResult.fromXDR(fixture.result_xdr, 'base64');
    assert.ok(res);
  }
  if (fixture.result_meta_xdr) {
    const meta = xdr.TransactionMeta.fromXDR(fixture.result_meta_xdr, 'base64');
    assert.ok(meta);
  }
});
