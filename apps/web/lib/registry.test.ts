import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { buildRestoreTransaction } from './registry-transactions.ts';

// The persistent entry an archived binding lives in, as the preamble names it.
const ARCHIVED_KEY = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(StrKey.encodeContract(Buffer.alloc(32, 0x7e))).toScAddress(),
    key: xdr.ScVal.scvString('alice'),
    durability: xdr.ContractDataDurability.persistent(),
  }),
);

/** A simulation as the SDK parses it from the RPC's JSON. */
function simulation(preamble: { minResourceFee: string } | null) {
  const empty = new SorobanDataBuilder().build().toXDR('base64');
  const footprint = new SorobanDataBuilder().setReadWrite([ARCHIVED_KEY]).build().toXDR('base64');
  return rpc.parseRawSimulation({
    id: '1',
    latestLedger: 1,
    transactionData: empty,
    minResourceFee: '100',
    results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
    ...(preamble
      ? { restorePreamble: { transactionData: footprint, minResourceFee: preamble.minResourceFee } }
      : {}),
  } as rpc.Api.RawSimulateTransactionResponse);
}

const account = () => new Account(Keypair.random().publicKey(), '100');

test('the restore carries the preamble footprint, its fee and one restoreFootprint', () => {
  const tx = buildRestoreTransaction(
    account(),
    simulation({ minResourceFee: '5000' }),
    Networks.TESTNET,
  );

  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0]?.type, 'restoreFootprint');
  assert.equal(tx.fee, (BigInt(BASE_FEE) + 5000n).toString());

  const data = tx.toEnvelope().v1().tx().ext().sorobanData();
  const readWrite = data.resources().footprint().readWrite();
  assert.equal(readWrite.length, 1);
  assert.equal(readWrite[0]?.toXDR('base64'), ARCHIVED_KEY.toXDR('base64'));
});

test('the restore uses the account sequence it is given, once', () => {
  const source = account();
  const tx = buildRestoreTransaction(source, simulation({ minResourceFee: '1' }), Networks.TESTNET);
  assert.equal(tx.sequence, '101');
});

test('a simulation without a restore preamble is not in an archived state', () => {
  assert.throws(
    () => buildRestoreTransaction(account(), simulation(null), Networks.TESTNET),
    /not in an archived state/,
  );
});
