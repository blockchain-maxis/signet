import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';

import { handleKeyScVal, main, ownerKeyScVal } from './keepalive-contract.mjs';

const CONTRACT_ID = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const WALLET = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const LATEST_LEDGER = 1_000_000;
const HASH = 'a'.repeat(64);

// Admission is built here from the raw XDR, independently of the script's own
// helpers, so a key-encoding mistake cannot pass both sides alike: the keys are
// exactly the shape apps/web/e2e/fixtures/contracts.ts builds for OWNER_KEY
// (a `#[contracttype]` tuple variant keys by name, not by variant index).
function ledgerKey(keyScVal) {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Contract(CONTRACT_ID).address().toScAddress(),
      key: keyScVal,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

const INSTANCE_KEY_SCVAL = xdr.ScVal.scvLedgerKeyContractInstance();
const OWNER_KEY_SCVAL = xdr.ScVal.scvVec([
  xdr.ScVal.scvSymbol('Owner'),
  xdr.ScVal.scvString('alice'),
]);
const HANDLE_KEY_SCVAL = xdr.ScVal.scvVec([
  xdr.ScVal.scvSymbol('Handle'),
  new Address(WALLET).toScVal(),
]);

function entry(keyScVal, val, liveUntilLedgerSeq) {
  return {
    key: ledgerKey(keyScVal),
    val: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: new Contract(CONTRACT_ID).address().toScAddress(),
        key: keyScVal,
        durability: xdr.ContractDataDurability.persistent(),
        val,
      }),
    ),
    lastModifiedLedgerSeq: LATEST_LEDGER - 10,
    liveUntilLedgerSeq,
  };
}

function successSim(keys = []) {
  const transactionData = new SorobanDataBuilder().setFootprint(keys, []).build();
  return { transactionData, latestLedger: LATEST_LEDGER, minResourceFee: '100' };
}

function stubServer({
  entries = [],
  extendSimulation = () => successSim(),
  resolveSimulation = () => successSim(),
  sendResult = { status: 'PENDING', hash: HASH },
  transactionStatus = 'SUCCESS',
} = {}) {
  const byKey = new Map(entries.map((e) => [e.key.toXDR('base64'), e]));
  const calls = { reads: [], simulations: [], submitted: [] };

  return {
    calls,
    async getNetwork() {
      return { passphrase: Networks.TESTNET };
    },
    async getLatestLedger() {
      return { sequence: LATEST_LEDGER };
    },
    async getLedgerEntries(...keys) {
      calls.reads.push(keys);
      return {
        entries: keys.map((key) => byKey.get(key.toXDR('base64'))).filter(Boolean),
        latestLedger: LATEST_LEDGER,
      };
    },
    async simulateTransaction(tx) {
      calls.simulations.push(tx);
      const operation = tx.operations[0];
      return operation.type === 'invokeHostFunction' ? resolveSimulation(tx) : extendSimulation(tx);
    },
    async getAccount(publicKey) {
      return new Account(publicKey, '7');
    },
    async sendTransaction(tx) {
      calls.submitted.push(tx);
      return sendResult;
    },
    async getTransaction() {
      return { status: transactionStatus };
    },
  };
}

function capture() {
  const lines = [];
  const record = (line) => lines.push(String(line));
  return {
    log: record,
    warn: record,
    errorLog: record,
    out: () => lines.join('\n'),
  };
}

function boundEntries() {
  return [
    entry(INSTANCE_KEY_SCVAL, xdr.ScVal.scvVoid(), LATEST_LEDGER + 4000),
    entry(OWNER_KEY_SCVAL, new Address(WALLET).toScVal(), LATEST_LEDGER + 3000),
    entry(HANDLE_KEY_SCVAL, nativeToScVal('alice', { type: 'string' }), LATEST_LEDGER + 2000),
  ];
}

function submittedFootprint(tx) {
  const footprint = tx.toEnvelope().v1().tx().ext().sorobanData().resources().footprint();
  return [...footprint.readOnly(), ...footprint.readWrite()].map((key) => key.toXDR('base64'));
}

test('binding keys use the contracttype symbol encoding', () => {
  // A `#[contracttype]` enum variant is a name, so `DataKey::Owner(handle)` is
  // ScVec[Symbol("Owner"), String(handle)] — never ScVec[U32(1), ...]. A wrong
  // key silently matches no stored entry, which is the bug behind #985.
  assert.equal(ownerKeyScVal('alice').toXDR('base64'), OWNER_KEY_SCVAL.toXDR('base64'));
  assert.equal(handleKeyScVal(WALLET).toXDR('base64'), HANDLE_KEY_SCVAL.toXDR('base64'));
  assert.notEqual(
    ownerKeyScVal('alice').toXDR('base64'),
    xdr.ScVal.scvVec([xdr.ScVal.scvU32(1), xdr.ScVal.scvString('alice')]).toXDR('base64'),
  );

  // The read must name the real keys, or no binding is ever found.
  const server = stubServer({ entries: boundEntries() });
  const output = capture();
  return main({
    argv: ['alice'],
    env: { REGISTRY_CONTRACT_ID: CONTRACT_ID },
    server,
    ...output,
  }).then(() => {
    const asked = new Set(server.calls.reads.flat().map((key) => key.toXDR('base64')));
    assert.ok(asked.has(ledgerKey(OWNER_KEY_SCVAL).toXDR('base64')));
    assert.ok(asked.has(ledgerKey(HANDLE_KEY_SCVAL).toXDR('base64')));
  });
});

test('report mode prints remaining ledgers and submits nothing', async () => {
  const server = stubServer({ entries: boundEntries() });
  const output = capture();

  const code = await main({
    argv: ['alice'],
    env: { REGISTRY_CONTRACT_ID: CONTRACT_ID },
    server,
    ...output,
  });

  assert.equal(code, 0);
  assert.match(output.out(), /instance: 4000 ledgers remaining/);
  assert.match(output.out(), /owner:alice: 3000 ledgers remaining/);
  assert.match(output.out(), new RegExp(`handle:${WALLET}: 2000 ledgers remaining`));
  assert.doesNotMatch(output.out(), /bumped/);
  assert.doesNotMatch(output.out(), /entries extended/);
  assert.equal(server.calls.submitted.length, 0);
});

test('an unbound handle is reported as unbound', async () => {
  const server = stubServer({
    entries: [entry(INSTANCE_KEY_SCVAL, xdr.ScVal.scvVoid(), LATEST_LEDGER + 4000)],
    resolveSimulation: () => ({ ...successSim(), result: { retval: xdr.ScVal.scvVoid() } }),
  });
  const output = capture();

  const code = await main({
    argv: ['alice'],
    env: { REGISTRY_CONTRACT_ID: CONTRACT_ID },
    server,
    ...output,
  });

  assert.equal(code, 0);
  assert.match(output.out(), /\[UNBOUND\] alice/);
  assert.equal(server.calls.submitted.length, 0);
});

test('a missing binding that resolve still answers for is never counted as extended', async () => {
  const signer = Keypair.random();
  const server = stubServer({
    entries: [entry(INSTANCE_KEY_SCVAL, xdr.ScVal.scvVoid(), LATEST_LEDGER + 4000)],
    resolveSimulation: () => ({
      ...successSim(),
      result: { retval: new Address(WALLET).toScVal() },
    }),
  });
  const output = capture();

  const code = await main({
    argv: ['alice'],
    env: { REGISTRY_CONTRACT_ID: CONTRACT_ID, KEEPALIVE_SECRET: signer.secret() },
    server,
    ...output,
    sleep: async () => {},
  });

  assert.equal(code, 0, output.out());
  assert.match(output.out(), /\[UNKNOWN\] alice/);
  assert.equal(server.calls.submitted.length, 1);

  // Only the instance exists, so only it may be extended and claimed.
  assert.deepEqual(submittedFootprint(server.calls.submitted[0]), [
    ledgerKey(INSTANCE_KEY_SCVAL).toXDR('base64'),
  ]);
  assert.match(
    output.out(),
    /Summary: 1 of 1 live entries in the submitted footprint \(0 unbound, 0 archived\)/,
  );
});

test('a restore preamble is reported as archived and exits 1', async () => {
  const server = stubServer({
    entries: [entry(INSTANCE_KEY_SCVAL, xdr.ScVal.scvVoid(), LATEST_LEDGER + 4000)],
    extendSimulation: () => ({
      ...successSim(),
      restorePreamble: {
        transactionData: new SorobanDataBuilder()
          .setFootprint([ledgerKey(INSTANCE_KEY_SCVAL)], [])
          .build(),
        minResourceFee: '100',
      },
    }),
  });
  const output = capture();

  const code = await main({
    argv: ['--instance-only'],
    env: { REGISTRY_CONTRACT_ID: CONTRACT_ID },
    server,
    ...output,
  });

  assert.equal(code, 1);
  assert.match(output.out(), /\[ARCHIVED\] instance/);
  assert.equal(server.calls.submitted.length, 0);
});

test('a missing contract id exits 1 with a usage message', async () => {
  const output = capture();

  const code = await main({ argv: ['alice'], env: {}, ...output });

  assert.equal(code, 1);
  assert.match(output.out(), /contract id is not set/);
  assert.match(output.out(), /Usage:/);
});

test('with a key, the submitted footprint holds the instance and both binding keys', async () => {
  const signer = Keypair.random();
  const server = stubServer({ entries: boundEntries() });
  const output = capture();

  const code = await main({
    argv: ['alice'],
    env: { REGISTRY_CONTRACT_ID: CONTRACT_ID, KEEPALIVE_SECRET: signer.secret() },
    server,
    ...output,
    sleep: async () => {},
  });

  assert.equal(code, 0, output.out());
  assert.equal(server.calls.submitted.length, 1);

  const tx = server.calls.submitted[0];
  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0].type, 'extendFootprintTtl');
  assert.equal(String(tx.source), signer.publicKey());

  assert.deepEqual(
    new Set(submittedFootprint(tx)),
    new Set([
      ledgerKey(INSTANCE_KEY_SCVAL).toXDR('base64'),
      ledgerKey(OWNER_KEY_SCVAL).toXDR('base64'),
      ledgerKey(HANDLE_KEY_SCVAL).toXDR('base64'),
    ]),
  );
  assert.match(
    output.out(),
    /Summary: 3 of 3 live entries in the submitted footprint \(0 unbound, 0 archived\)/,
  );
});
