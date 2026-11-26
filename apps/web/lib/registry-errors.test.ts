import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainRegistryError } from './registry-errors.ts';

test('maps Error(Contract, #N) codes 3, 6, 7 and 8 to plain messages', () => {
  assert.equal(
    explainRegistryError(new Error('Simulation failed: HostError: Error(Contract, #3)')),
    'That handle is already taken.',
  );
  assert.equal(
    explainRegistryError('HostError: Error(Contract, #6)'),
    'That handle is invalid. Use 1–32 lowercase letters, digits, hyphens, or underscores.',
  );
  assert.equal(
    explainRegistryError(new Error('HostError: Error(Contract, #7)')),
    'This wallet already has a handle.',
  );
  assert.equal(
    explainRegistryError('HostError: Error(Contract, #8)'),
    'That handle is reserved for a Signet route.',
  );
});

test('maps JSON submission error payloads carrying contractError', () => {
  const err = new Error('Claim submission failed: {"errorResult":{"code":"contractError","value":3}}');
  assert.equal(explainRegistryError(err), 'That handle is already taken.');
});

test('keeps the original text for unrecognised contract codes and other errors', () => {
  const unknownCode = 'HostError: Error(Contract, #99)';
  assert.equal(explainRegistryError(new Error(unknownCode)), unknownCode);

  const networkErr = 'Soroban RPC timed out after 10s';
  assert.equal(explainRegistryError(new Error(networkErr)), networkErr);
  assert.equal(explainRegistryError(networkErr), networkErr);
});
