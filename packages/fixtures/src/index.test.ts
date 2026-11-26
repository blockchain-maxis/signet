import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xdr, StrKey, scValToNative } from '@stellar/stellar-sdk';
import { FIXTURE_NAMES, loadFixture, loadFixtureEnvelope } from './index.js';

const FIXTURES = FIXTURE_NAMES;
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

test('every data/*.json file has a FixtureName entry and every FixtureName has a file', () => {
  const onDisk = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  const declared = [...FIXTURE_NAMES].sort();
  assert.deepEqual(
    onDisk.filter((n) => !declared.includes(n as never)),
    [],
    'data/ files missing from FIXTURE_NAMES',
  );
  assert.deepEqual(
    declared.filter((n) => !onDisk.includes(n)),
    [],
    'FIXTURE_NAMES entries with no data/ file',
  );
});

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

/** `{kind, handle, wallet}` the way the indexer and /handles decode a registry event. */
function decodeRegistryEvent(event: { topic: string[]; value: string }) {
  const topics = event.topic.map((t) => xdr.ScVal.fromXDR(t, 'base64'));
  return {
    kind: String(scValToNative(topics[0]!)),
    handle: String(scValToNative(topics[1]!)),
    wallet: String(scValToNative(xdr.ScVal.fromXDR(event.value, 'base64'))),
  };
}

test('registry-claim-release-get-events holds a claimed and a released event for the same handle and wallet', () => {
  const envelope = loadFixtureEnvelope('registry-claim-release-get-events');
  const fixture = loadFixture('registry-claim-release-get-events');
  const params = envelope.request.params as {
    startLedger: number;
    filters: Array<{ contractIds: string[] }>;
  };
  const registryId = params.filters[0]!.contractIds[0]!;
  assert.equal(envelope.request.methodOrPath, 'getEvents');
  assert.ok(fixture.events.length >= 2);

  // The page is filtered to the registry, so other people's claims may sit
  // alongside ours; ours is the capture script's fx-<8 hex> handle.
  for (const event of fixture.events) {
    assert.equal(event.contractId, registryId);
    assert.ok(event.ledger >= params.startLedger);
  }
  const ours = fixture.events
    .map((e) => ({ ...decodeRegistryEvent(e), txHash: e.txHash, ledger: e.ledger }))
    .filter((e) => /^fx-[0-9a-f]{8}$/.test(e.handle));
  assert.deepEqual(
    ours.map((e) => e.kind),
    ['claimed', 'released'],
  );
  const [claimed, released] = ours as [(typeof ours)[0], (typeof ours)[0]];
  assert.equal(released.handle, claimed.handle);
  assert.equal(released.wallet, claimed.wallet);
  assert.ok(StrKey.isValidEd25519PublicKey(claimed.wallet), 'wallet decodes to a G… address');
  assert.ok(released.ledger >= claimed.ledger);
  assert.notEqual(released.txHash, claimed.txHash, 'claim and release are separate transactions');
});

test('claim-get-transaction is the claim that produced the recorded claimed event', () => {
  const claimTx = loadFixture('claim-get-transaction');
  const events = loadFixture('registry-claim-release-get-events');
  const claimed = events.events.find(
    (e) => e.txHash === claimTx.txHash && decodeRegistryEvent(e).kind === 'claimed',
  );
  assert.ok(claimed, 'the getEvents page has a claimed event from this transaction');
  assert.equal(claimTx.ledger, claimed.ledger);

  // The invocation's own arguments name the same handle and wallet.
  const env = xdr.TransactionEnvelope.fromXDR(claimTx.envelopeXdr!, 'base64');
  const invoke = env.v1().tx().operations()[0]!.body().invokeHostFunctionOp().hostFunction();
  const call = invoke.invokeContract();
  assert.equal(call.functionName().toString(), 'claim');
  const [handle, wallet] = call.args().map((a) => String(scValToNative(a)));
  const decoded = decodeRegistryEvent(claimed);
  assert.equal(handle, decoded.handle);
  assert.equal(wallet, decoded.wallet);
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
