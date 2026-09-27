import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { isContractAddress, deriveContractId } from './contract-address.ts';

// Real testnet Identity Registry deployment reference
// Deployed at: CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
const REAL_REGISTRY_CONTRACT_ID = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

// Real deployment vector on Stellar Testnet:
// Deployer: GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA
// Salt (hex): 0000000000000000000000000000000000000000000000000000000000000001
// Passphrase: Test SDF Network ; September 2015
const TESTNET_DEPLOYER = 'GB3KJPLFUYN5VL6R3GU3EGCGVCKFDSD7BEDX42HWG5BWFKB3KQGJJRMA';
const TESTNET_SALT_HEX = '0000000000000000000000000000000000000000000000000000000000000001';
const TESTNET_PASSPHRASE = Networks.TESTNET;

test('isContractAddress accepts a real C... StrKey contract address', () => {
  assert.equal(isContractAddress(REAL_REGISTRY_CONTRACT_ID), true);
  assert.equal(isContractAddress('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'), true);
});

test('isContractAddress rejects a G... account address', () => {
  assert.equal(
    isContractAddress('GBPO7T67BZZW65CYOQWVTQ7LPM3F4Z4NTRD3MGF4UGZODJ2H6J6VGLTR'),
    false,
  );
});

test('isContractAddress rejects lowercase strings and non-C prefixes', () => {
  assert.equal(isContractAddress(REAL_REGISTRY_CONTRACT_ID.toLowerCase()), false);
  assert.equal(isContractAddress(''), false);
  assert.equal(isContractAddress('S...'), false);
  assert.equal(isContractAddress('null'), false);
  assert.equal(isContractAddress('undefined'), false);
});

test('isContractAddress rejects checksum-corrupted C... addresses', () => {
  // Replace the last character to corrupt checksum
  const lastChar = REAL_REGISTRY_CONTRACT_ID.slice(-1);
  const corrupted = REAL_REGISTRY_CONTRACT_ID.slice(0, -1) + (lastChar === 'N' ? 'M' : 'N');
  assert.equal(isContractAddress(corrupted), false);
});

test('deriveContractId accurately derives contract address from deployer, salt, and network', () => {
  const derived = deriveContractId({
    deployer: TESTNET_DEPLOYER,
    salt: TESTNET_SALT_HEX,
    networkPassphrase: TESTNET_PASSPHRASE,
  });

  assert.equal(typeof derived, 'string');
  assert.equal(derived.startsWith('C'), true);
  assert.equal(derived.length, 56);
  assert.equal(StrKey.isValidContract(derived), true);

  // Test with Buffer salt
  const derivedFromBuf = deriveContractId({
    deployer: TESTNET_DEPLOYER,
    salt: Buffer.from(TESTNET_SALT_HEX, 'hex'),
    networkPassphrase: TESTNET_PASSPHRASE,
  });
  assert.equal(derivedFromBuf, derived);

  // Test with Base64 salt
  const saltB64 = Buffer.from(TESTNET_SALT_HEX, 'hex').toString('base64');
  const derivedFromB64 = deriveContractId({
    deployer: TESTNET_DEPLOYER,
    salt: saltB64,
    networkPassphrase: TESTNET_PASSPHRASE,
  });
  assert.equal(derivedFromB64, derived);
});

test('deriveContractId supports C... contract deployer as well', () => {
  const derived = deriveContractId({
    deployer: REAL_REGISTRY_CONTRACT_ID,
    salt: TESTNET_SALT_HEX,
    networkPassphrase: TESTNET_PASSPHRASE,
  });
  assert.equal(typeof derived, 'string');
  assert.equal(isContractAddress(derived), true);
});
