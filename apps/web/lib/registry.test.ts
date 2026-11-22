import test from 'node:test';
import assert from 'node:assert/strict';
import { Account, BASE_FEE, Keypair, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { buildRestoreTransaction } from './registry.ts';

test('buildRestoreTransaction builds a restore transaction with footprint, fee, and restoreFootprint operation', () => {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '100');

  const footprint = new SorobanDataBuilder();
  const minResourceFee = '5000';
  const sim = {
    transactionData: new SorobanDataBuilder().build().toXDR('base64'),
    restorePreamble: {
      minResourceFee,
      transactionData: footprint,
    },
  };

  const tx = buildRestoreTransaction(account, sim);

  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0]?.type, 'restoreFootprint');
  assert.equal(tx.fee, (BigInt(BASE_FEE) + BigInt(minResourceFee)).toString());
  assert.ok(tx.toEnvelope().v1().tx().ext().sorobanData());
});

test('buildRestoreTransaction accepts serialized/string transactionData in restorePreamble', () => {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '100');

  const footprintXdr = new SorobanDataBuilder().build().toXDR('base64');
  const minResourceFee = '2000';
  const sim = {
    transactionData: footprintXdr,
    restorePreamble: {
      minResourceFee,
      transactionData: footprintXdr,
    },
  };

  const tx = buildRestoreTransaction(account, sim);

  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0]?.type, 'restoreFootprint');
  assert.equal(tx.fee, (BigInt(BASE_FEE) + BigInt(minResourceFee)).toString());
  assert.ok(tx.toEnvelope().v1().tx().ext().sorobanData());
});

test('buildRestoreTransaction accepts raw xdr.SorobanTransactionData in restorePreamble', () => {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '100');

  const footprintData = new SorobanDataBuilder().build();
  const minResourceFee = '3000';
  const sim = {
    transactionData: footprintData.toXDR('base64'),
    restorePreamble: {
      minResourceFee,
      transactionData: footprintData,
    },
  };

  const tx = buildRestoreTransaction(account, sim);

  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0]?.type, 'restoreFootprint');
  assert.equal(tx.fee, (BigInt(BASE_FEE) + BigInt(minResourceFee)).toString());
});

test('buildRestoreTransaction throws "not in an archived state" when simulation lacks restore preamble', () => {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '100');

  const simWithoutPreamble = {
    transactionData: 'AAAA...',
    result: { retval: '...' },
  };

  assert.throws(
    () => buildRestoreTransaction(account, simWithoutPreamble),
    /not in an archived state/,
  );

  assert.throws(
    () => buildRestoreTransaction(account, {}),
    /not in an archived state/,
  );
});
