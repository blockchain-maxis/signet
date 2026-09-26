import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Contract, ContractWasmVersion, Prisma } from './index.ts';

test('exports Contract model with new wasm fields and ContractWasmVersion', () => {
  const version: ContractWasmVersion = {
    id: 'ver_1',
    contractId: 'c_1',
    wasmHash: 'a'.repeat(64),
    observedAt: new Date(),
    observedLedger: 123456,
  };

  const contract: Contract = {
    id: 'c_1',
    address: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    walletId: 'w_1',
    deployerPubkey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    deployedAt: new Date(),
    deployTxHash: 'tx_1',
    network: 'testnet',
    contractType: null,
    wasmHash: 'a'.repeat(64),
    executableType: 'wasm',
    wasmHashCheckedAt: new Date(),
    firstIndexedAt: new Date(),
  };

  assert.equal(version.observedLedger, 123456);
  assert.equal(contract.executableType, 'wasm');
});
