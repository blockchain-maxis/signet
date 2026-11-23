import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Address,
  Horizon,
  Networks,
  NotFoundError,
  hash,
  scValToNative,
  xdr,
  StrKey,
} from '@stellar/stellar-sdk';
import {
  loadFixture,
  loadFixtureEnvelope,
  replayHorizon,
  type FixtureName,
  type HorizonOperationRecord,
} from './index.js';

const FIXTURES: FixtureName[] = [
  'registry-instance-entry',
  'sac-instance-entry',
  'contract-wasm-entry',
  'claim-get-transaction',
  'deploy-get-transaction',
  'sac-transfer-call-get-transaction',
  'footprint-only-call-get-transaction',
  'horizon-contract-deploy-tx',
  'horizon-account-operations-page',
  'horizon-account-operations-first-page',
  'horizon-account-operations-end',
  'horizon-create-contract-v2-tx',
  'horizon-create-contract-operation',
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

// Horizon operation records (#974).

const DEPLOYER = 'GC6IQQHUT4BXZYCJEM4AOKFD6ASWSXCEDXYPVA5NFKXSGOSRJX72KJMC';
const INVOKE = 'HostFunctionTypeHostFunctionTypeInvokeContract';
const CREATE = 'HostFunctionTypeHostFunctionTypeCreateContract';
const CREATE_V2 = 'HostFunctionTypeHostFunctionTypeCreateContractV2';

/** The contract and the function an invocation record names: its first two parameters. */
function invoked(op: HorizonOperationRecord): { contract: string; fn: string } {
  const [contract, fn] = op.parameters!;
  assert.equal(contract!.type, 'Address');
  assert.equal(fn!.type, 'Sym');
  return {
    contract: Address.fromScVal(xdr.ScVal.fromXDR(contract!.value, 'base64')).toString(),
    fn: scValToNative(xdr.ScVal.fromXDR(fn!.value, 'base64')) as string,
  };
}

/**
 * The address of a contract created from an address and a salt: the hash of
 * its contract-id preimage. Horizon prints the 32-byte salt as a decimal
 * integer.
 */
function contractCreatedFrom(deployer: string, salt: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt: Buffer.from(BigInt(salt).toString(16).padStart(64, '0'), 'hex'),
        }),
      ),
    }),
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

test("horizon-account-operations-page is the deployer's newest page, as both workers ask for it", () => {
  const envelope = loadFixtureEnvelope('horizon-account-operations-page');
  assert.equal(envelope.request.endpoint, 'horizon');
  assert.equal(
    envelope.request.methodOrPath,
    `/accounts/${DEPLOYER}/operations?order=desc&limit=50`,
  );

  const records = loadFixture('horizon-account-operations-page')._embedded.records;
  assert.equal(records.length, 50);
  // Newest first, and every one sent by the deployer.
  const tokens = records.map((op) => BigInt(op.paging_token));
  assert.ok(tokens.every((token, i) => i === 0 || token < tokens[i - 1]!));
  assert.ok(records.every((op) => op.source_account === DEPLOYER));
  assert.ok(records.every((op) => op.type === 'invoke_host_function'));

  // Horizon prints the host function's type name twice. No record carries the
  // single-prefix spelling the hand-built test records used (#959).
  const functions = new Map<string, number>();
  for (const op of records) functions.set(op.function!, (functions.get(op.function!) ?? 0) + 1);
  assert.deepEqual([...functions].sort(), [
    [CREATE_V2, 1],
    [INVOKE, 49],
  ]);

  // Every invocation names its contract and its function in its parameters (#967).
  for (const op of records.filter((r) => r.function === INVOKE)) {
    const { contract, fn } = invoked(op);
    assert.ok(StrKey.isValidContract(contract), `${op.id}: ${contract}`);
    assert.match(fn, /^[a-z][a-z0-9_]*$/, op.id);
  }
  assert.deepEqual(invoked(records[0]!), {
    contract: 'CAII4K5S4GJPBSYXT4K2ZKYSEEAY6TA7GCTDIINFBATORY4N7PINPPPB',
    fn: 'claim_revenue',
  });
});

test("horizon-account-operations-first-page is the deployer's first four operations", () => {
  const page = loadFixture('horizon-account-operations-first-page');
  const records = page._embedded.records;
  assert.deepEqual(
    records.map((op) => [op.type, op.function ?? null]),
    [
      ['invoke_host_function', INVOKE],
      ['invoke_host_function', INVOKE],
      ['invoke_host_function', CREATE_V2],
      ['create_account', null],
    ],
  );
  // The funding is the one record another account sent.
  const funding = records[3]!;
  assert.equal(funding.account, DEPLOYER);
  assert.notEqual(funding.source_account, DEPLOYER);
  assert.ok(records.slice(0, 3).every((op) => op.source_account === DEPLOYER));

  // A create-contract record carries no parameters that name a contract. It
  // carries the deployer and the salt, and those two give the address of the
  // contract it created: the one the next two operations call.
  const create = records[2]!;
  assert.equal(create.address, DEPLOYER);
  const created = contractCreatedFrom(create.address!, create.salt!);
  assert.equal(created, 'CAII4K5S4GJPBSYXT4K2ZKYSEEAY6TA7GCTDIINFBATORY4N7PINPPPB');
  assert.deepEqual(invoked(records[1]!), { contract: created, fn: 'deploy_pool' });
  assert.deepEqual(invoked(records[0]!), { contract: created, fn: 'deploy_position_nft' });
});

test('horizon-account-operations-end is the empty page Horizon answers with after the first', () => {
  const first = loadFixture('horizon-account-operations-first-page');
  const end = loadFixtureEnvelope('horizon-account-operations-end');
  const next = new URL(first._links.next.href);
  assert.equal(end.request.methodOrPath, next.pathname + next.search);
  assert.equal(next.searchParams.get('cursor'), first._embedded.records.at(-1)!.paging_token);
  assert.deepEqual(loadFixture('horizon-account-operations-end')._embedded.records, []);
});

test('horizon-create-contract-v2-tx is the transaction of the create-contract (V2) record', () => {
  const tx = loadFixture('horizon-create-contract-v2-tx');
  const create = loadFixture('horizon-account-operations-first-page')._embedded.records[2]!;
  assert.equal(tx.hash, create.transaction_hash);
  assert.equal(tx.source_account, DEPLOYER);

  const op = xdr.TransactionEnvelope.fromXDR(tx.envelope_xdr, 'base64')
    .v1()
    .tx()
    .operations()[0]!
    .body();
  assert.equal(
    op.invokeHostFunctionOp().hostFunction().switch().name,
    'hostFunctionTypeCreateContractV2',
  );
  xdr.TransactionResult.fromXDR(tx.result_xdr, 'base64');
  // As for the other Horizon transaction: no result meta, so no return value
  // to read the new contract's address from.
  assert.equal(tx.result_meta_xdr, undefined);
});

test('horizon-create-contract-operation is the operation of the recorded deployment', () => {
  const op = loadFixture('horizon-create-contract-operation');
  const tx = loadFixture('horizon-contract-deploy-tx');
  assert.equal(op.transaction_hash, tx.hash);
  assert.equal(op.type, 'invoke_host_function');
  assert.equal(op.function, CREATE);
  assert.equal(op.source_account, tx.source_account);
  assert.equal(op.created_at, tx.created_at);
  // This one was created from an asset, not from an address, so Horizon gives
  // it neither a deployer nor a salt.
  assert.equal(op.address, '');
  assert.equal(op.salt, '');
});

// The replay: the SDK's own client over the recordings.

test("replayHorizon serves the recordings to the SDK's Horizon.Server, links and all", async () => {
  const replay = replayHorizon([
    loadFixtureEnvelope('horizon-account-operations-first-page'),
    loadFixtureEnvelope('horizon-account-operations-end'),
    loadFixtureEnvelope('horizon-create-contract-v2-tx'),
  ]);
  try {
    const server = new Horizon.Server(replay.url);
    const first = await server
      .operations()
      .forAccount(DEPLOYER)
      .order('desc')
      .limit(50)
      .cursor('20988414253887489')
      .call();
    assert.equal(first.records.length, 4);
    assert.equal(first.records[2]!.type, 'invoke_host_function');

    // The next link is Horizon's own, and it leads to the recorded empty page.
    const end = await first.next();
    assert.deepEqual(end.records, []);

    // The SDK renames a transaction's `ledger`, and there is no result meta.
    const hashOf = first.records[2]!.transaction_hash;
    const tx = await server.transactions().transaction(hashOf).call();
    assert.equal(typeof tx.ledger_attr, 'number');
    assert.equal(tx.result_meta_xdr, undefined);

    assert.deepEqual(replay.requests, [
      `/accounts/${DEPLOYER}/operations?cursor=20988414253887489&limit=50&order=desc`,
      `/accounts/${DEPLOYER}/operations?cursor=20988379894132737&limit=50&order=desc`,
      `/transactions/${hashOf}`,
    ]);
    assert.deepEqual(replay.unanswered, []);
  } finally {
    replay.restore();
  }
});

test('replayHorizon answers 404 for what was not recorded, and says which request it was', async () => {
  const before = globalThis.fetch;
  // A later entry for one request replaces an earlier one, whatever order its query is in.
  const replay = replayHorizon([
    { path: '/transactions/abc', body: { hash: 'abc' } },
    { path: '/x?b=2&a=1', body: { which: 'first' } },
    { path: '/x?a=1&b=2', body: { which: 'second' } },
  ]);
  try {
    const server = new Horizon.Server(replay.url);
    await assert.rejects(() => server.transactions().transaction('def').call(), NotFoundError);
    assert.deepEqual(replay.unanswered, ['/transactions/def']);
    const answered = await fetch(`${replay.url}/x?b=2&a=1`);
    assert.deepEqual(await answered.json(), { which: 'second' });
    assert.deepEqual(replay.requests, ['/transactions/def', '/x?a=1&b=2']);
    // Nothing may reach the network while a replay is in place.
    await assert.rejects(() => fetch('https://horizon-testnet.stellar.org/'), /nothing may reach/);
  } finally {
    replay.restore();
  }
  assert.equal(globalThis.fetch, before);
  assert.throws(
    () => replayHorizon([loadFixtureEnvelope('deploy-get-transaction')]),
    /not a Horizon recording/,
  );
});
