import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCreateContractFunction } from './contract.ts';

test('isCreateContractFunction returns true for both real Horizon spellings', () => {
  assert.equal(isCreateContractFunction('HostFunctionTypeHostFunctionTypeCreateContract'), true);
  assert.equal(isCreateContractFunction('HostFunctionTypeHostFunctionTypeCreateContractV2'), true);
});

test('isCreateContractFunction returns true for both legacy single-prefix spellings', () => {
  assert.equal(isCreateContractFunction('HostFunctionTypeCreateContract'), true);
  assert.equal(isCreateContractFunction('HostFunctionTypeCreateContractV2'), true);
});

test('isCreateContractFunction returns false for InvokeContract and other functions', () => {
  assert.equal(isCreateContractFunction('HostFunctionTypeHostFunctionTypeInvokeContract'), false);
  assert.equal(isCreateContractFunction('HostFunctionTypeInvokeContract'), false);
  assert.equal(isCreateContractFunction('HostFunctionTypeHostFunctionTypeUploadContractWasm'), false);
  assert.equal(isCreateContractFunction('HostFunctionTypeUploadContractWasm'), false);
});

test('isCreateContractFunction returns false for undefined, empty, or arbitrary strings', () => {
  assert.equal(isCreateContractFunction(undefined), false);
  assert.equal(isCreateContractFunction(''), false);
  assert.equal(isCreateContractFunction('create_contract'), false);
});
