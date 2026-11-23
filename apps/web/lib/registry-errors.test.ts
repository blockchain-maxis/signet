import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainRegistryError, explainReleaseError } from './registry-errors.ts';

test('maps Error(Contract, #N) codes 3, 4, 6, 7 and 8 to plain messages', () => {
  assert.equal(
    explainRegistryError(new Error('Simulation failed: HostError: Error(Contract, #3)')),
    'That handle is already taken.',
  );
  assert.equal(
    explainRegistryError(new Error('Simulation failed: HostError: Error(Contract, #4)')),
    'Handle not found.',
  );
  assert.equal(explainRegistryError('HostError: Error(Contract, #4)'), 'Handle not found.');
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

test('maps auth failures to plain message when wallet is not the owner', () => {
  assert.equal(
    explainRegistryError(new Error('Simulation failed: HostError: Error(Auth, InvalidAction)')),
    'You are not the owner of that handle.',
  );
  assert.equal(
    explainRegistryError('HostError: Error(Auth, InvalidAction)'),
    'You are not the owner of that handle.',
  );
  assert.equal(
    explainReleaseError(
      new Error('Release submission failed: {"errorResult":"Error(Auth, InvalidAction)"}'),
    ),
    'You are not the owner of that handle.',
  );
});

test('maps JSON submission error payloads carrying contractError', () => {
  const errClaim = new Error(
    'Claim submission failed: {"errorResult":{"code":"contractError","value":3}}',
  );
  assert.equal(explainRegistryError(errClaim), 'That handle is already taken.');

  const errRelease = new Error(
    'Release submission failed: {"errorResult":{"code":"contractError","value":4}}',
  );
  assert.equal(explainReleaseError(errRelease), 'Handle not found.');
});

test('keeps the original text for unrecognised contract codes and other errors', () => {
  const unknownCode = 'HostError: Error(Contract, #99)';
  assert.equal(explainRegistryError(new Error(unknownCode)), unknownCode);

  const networkErr = 'Soroban RPC timed out after 10s';
  assert.equal(explainRegistryError(new Error(networkErr)), networkErr);
  assert.equal(explainRegistryError(networkErr), networkErr);
});
