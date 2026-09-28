import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { isContractAddress, deriveContractId } from './contract-address.ts';

// Real testnet Identity Registry deployment reference
// Deployed at: CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN
const REAL_REGISTRY_CONTRACT_ID = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

// Real create-contract deployment on Stellar Testnet, confirmed against the
// chain (not just self-consistency): the deployer, salt and passphrase below
// reproduce the exact contract address the network assigned.
// Tx hash: ea7a9098e63e588d81bb3aeff8c09fe2d82767228ae99a04f3039de915e753a2
// (getTransaction resultMetaXdr's Soroban return value decodes to the same
// address as deriveContractId below).
const TESTNET_DEPLOYER = 'GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU';
const TESTNET_SALT_HEX = '075afa7ea513abbddc97610bbef3276c89be0a040c3e914920dd7efb424a6ad6';
const TESTNET_PASSPHRASE = Networks.TESTNET;
const TESTNET_EXPECTED_CONTRACT_ID = 'CAMYYJCHOQZSTF2KF6WY4UMFXS75VI46NEGKWE6XHWFULYD46BE5EUXZ';

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

  // The real assertion: this must equal the contract address the network
  // actually assigned to that deployment, not just look like a valid one.
  assert.equal(derived, TESTNET_EXPECTED_CONTRACT_ID);
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
