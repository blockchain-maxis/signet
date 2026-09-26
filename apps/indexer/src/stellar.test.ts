import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr, StrKey, Keypair } from '@stellar/stellar-sdk';
import { extractContractAddress } from './stellar.ts';

const KNOWN_CONTRACT = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

/**
 * Synthetic v3 meta built with the SDK's XDR types (shape of a pre-protocol-23
 * Soroban create-contract result). Not a recorded testnet transaction; swap in
 * a recorded one once the @signet/fixtures package (#413) lands.
 */
function buildV3Meta(contractAddress: string): string {
  const contractId = StrKey.decodeContract(contractAddress);
  const scAddress = xdr.ScAddress.scAddressTypeContract(
    contractId as unknown as Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0],
  );
  const sorobanMeta = new xdr.SorobanTransactionMeta({
    ext: new xdr.SorobanTransactionMetaExt(0),
    events: [],
    returnValue: xdr.ScVal.scvAddress(scAddress),
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

/**
 * Synthetic v4 meta built with the SDK's XDR types (shape of a protocol 23+
 * Soroban result, `SorobanTransactionMetaV2` with a nullable return value).
 * Not a recorded testnet transaction; swap in a recorded one once the
 * @signet/fixtures package (#413) lands.
 */
function buildV4Meta(returnValue: xdr.ScVal | null): string {
  const sorobanMeta = new xdr.SorobanTransactionMetaV2({
    ext: new xdr.SorobanTransactionMetaExt(0),
    returnValue,
  });
  const v4 = new xdr.TransactionMetaV4({
    ext: new xdr.ExtensionPoint(0),
    txChangesBefore: [],
    operations: [],
    txChangesAfter: [],
    sorobanMeta,
    events: [],
    diagnosticEvents: [],
  });
  return new xdr.TransactionMeta(4, v4).toXDR('base64');
}

test('extractContractAddress decodes TransactionMeta v3 to contract address', () => {
  const v3Xdr = buildV3Meta(KNOWN_CONTRACT);
  const res = extractContractAddress(v3Xdr);
  assert.deepEqual(res, { ok: true, address: KNOWN_CONTRACT, metaVersion: 3 });
});

test('extractContractAddress decodes TransactionMeta v4 to contract address', () => {
  const contractId = StrKey.decodeContract(KNOWN_CONTRACT);
  const scAddress = xdr.ScAddress.scAddressTypeContract(
    contractId as unknown as Parameters<typeof xdr.ScAddress.scAddressTypeContract>[0],
  );
  const v4Xdr = buildV4Meta(xdr.ScVal.scvAddress(scAddress));
  const res = extractContractAddress(v4Xdr);
  assert.deepEqual(res, { ok: true, address: KNOWN_CONTRACT, metaVersion: 4 });
});

test('extractContractAddress returns no-return-value for v4 meta with null returnValue', () => {
  const v4Xdr = buildV4Meta(null);
  const res = extractContractAddress(v4Xdr);
  assert.deepEqual(res, { ok: false, reason: 'no-return-value', metaVersion: 4 });
});

test('extractContractAddress returns not-contract-address when returnValue is not a contract address', () => {
  // Not an address ScVal (e.g. u32)
  const nonAddrXdr = buildV4Meta(xdr.ScVal.scvU32(12345));
  const res1 = extractContractAddress(nonAddrXdr);
  assert.deepEqual(res1, { ok: false, reason: 'not-contract-address', metaVersion: 4 });

  // Account address rather than contract address
  const accountScAddress = xdr.ScAddress.scAddressTypeAccount(Keypair.random().xdrAccountId());
  const accountAddrXdr = buildV4Meta(xdr.ScVal.scvAddress(accountScAddress));
  const res2 = extractContractAddress(accountAddrXdr);
  assert.deepEqual(res2, { ok: false, reason: 'not-contract-address', metaVersion: 4 });
});

test('extractContractAddress returns decode-error for garbage base64', () => {
  const res = extractContractAddress('invalid-base64-garbage!@#$%');
  assert.deepEqual(res, { ok: false, reason: 'decode-error' });
});

test('extractContractAddress returns unsupported-meta-version for v1 or v2 meta', () => {
  const v1 = new xdr.TransactionMetaV1({
    txChanges: [],
    operations: [],
  });
  const v1Xdr = new xdr.TransactionMeta(1, v1).toXDR('base64');
  const res = extractContractAddress(v1Xdr);
  assert.deepEqual(res, { ok: false, reason: 'unsupported-meta-version', metaVersion: 1 });
});
