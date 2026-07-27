import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractErrorMessage, parseClaimError } from './contract-errors.ts';

// ── contractErrorMessage ────────────────────────────────────────────────────

test('contractErrorMessage(1) — AlreadyInitialized', () => {
  assert.match(contractErrorMessage(1), /already initialised/i);
});

test('contractErrorMessage(2) — NotInitialized', () => {
  assert.match(contractErrorMessage(2), /not been initialised/i);
});

test('contractErrorMessage(3) — HandleTaken', () => {
  assert.match(contractErrorMessage(3), /already taken/i);
});

test('contractErrorMessage(4) — HandleNotFound', () => {
  assert.match(contractErrorMessage(4), /not found/i);
});

test('contractErrorMessage(5) — NotOwner', () => {
  assert.match(contractErrorMessage(5), /not the owner/i);
});

test('contractErrorMessage(6) — InvalidHandle', () => {
  assert.match(contractErrorMessage(6), /invalid/i);
});

test('contractErrorMessage(7) — WalletAlreadyBound', () => {
  assert.match(contractErrorMessage(7), /already has a handle/i);
});

test('contractErrorMessage — unknown code falls back to generic string', () => {
  const msg = contractErrorMessage(99);
  assert.ok(msg.length > 0, 'fallback must be a non-empty string');
  assert.match(msg, /unexpected|unknown|error/i);
});

test('contractErrorMessage — returns a string for every known error code', () => {
  const knownCodes = [1, 2, 3, 4, 5, 6, 7];
  for (const code of knownCodes) {
    const msg = contractErrorMessage(code);
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, `code ${code} must have a non-empty message`);
  }
});

// ── parseClaimError ─────────────────────────────────────────────────────────

test('parseClaimError — extracts human message from a Soroban contract error JSON', () => {
  const raw = JSON.stringify({ code: 'contractError', value: 3 });
  const err = new Error(`Claim submission failed: ${raw}`);
  assert.match(parseClaimError(err), /already taken/i);
});

test('parseClaimError — handles nested Soroban error structure', () => {
  const raw = JSON.stringify({ status: 'ERROR', errorResult: { code: 'contractError', value: 7 } });
  const err = new Error(`Claim submission failed: ${raw}`);
  assert.match(parseClaimError(err), /already has a handle/i);
});

test('parseClaimError — falls back to error.message when JSON has no contract code', () => {
  const err = new Error('Network request timed out');
  assert.equal(parseClaimError(err), 'Network request timed out');
});

test('parseClaimError — falls back to generic message for non-Error thrown values', () => {
  const msg = parseClaimError('something broke');
  assert.ok(msg.length > 0);
  assert.match(msg, /unexpected|unknown|error/i);
});

test('parseClaimError — handles malformed JSON gracefully', () => {
  const err = new Error('Claim submission failed: {not valid json}');
  // Should not throw; falls back to the raw message.
  const result = parseClaimError(err);
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
});

test('parseClaimError — maps code 6 (InvalidHandle) correctly', () => {
  const raw = JSON.stringify({ code: 'contractError', value: 6 });
  const err = new Error(`Claim submission failed: ${raw}`);
  assert.match(parseClaimError(err), /invalid/i);
});
