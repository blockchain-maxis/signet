import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  HANDLE_MAX_LEN,
  HANDLE_PATTERN,
  RESERVED_HANDLES,
  isClaimableHandle,
  isReservedHandle,
  isValidHandle,
} from './handle.ts';

// Parity guard: these constants exist only to mirror the on-chain contract.
// If lib.rs changes and this file doesn't, the mirror is silently wrong and
// the app starts telling users a reserved handle is available again.
const here = dirname(fileURLToPath(import.meta.url));
const LIB_RS = resolve(here, '../../contracts/identity-registry/src/lib.rs');
const contractSource = readFileSync(LIB_RS, 'utf8');

test('contract source is readable at the expected path', () => {
  assert.ok(
    contractSource.includes('fn validate_handle'),
    `expected the identity-registry contract at ${LIB_RS}; if it moved, update this test`,
  );
});

test('HANDLE_MAX_LEN matches MAX_HANDLE_LEN in the contract', () => {
  const match = contractSource.match(/const\s+MAX_HANDLE_LEN\s*:\s*u32\s*=\s*(\d+)\s*;/);
  assert.ok(match, 'could not find MAX_HANDLE_LEN in lib.rs');
  const declared = match[1];
  assert.ok(declared !== undefined);
  assert.equal(Number(declared), HANDLE_MAX_LEN);
});

test('RESERVED_HANDLES matches the contract list exactly', () => {
  const block = contractSource.match(
    /const\s+RESERVED_HANDLES\s*:\s*\[&str;\s*(\d+)\]\s*=\s*\[([^\]]*)\]\s*;/,
  );
  assert.ok(block, 'could not find RESERVED_HANDLES in lib.rs');

  const [, declaredLenRaw, entries] = block;
  assert.ok(declaredLenRaw !== undefined && entries !== undefined);

  const declaredLen = Number(declaredLenRaw);
  const fromContract = [...entries.matchAll(/"([^"]*)"/g)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );

  assert.equal(
    fromContract.length,
    declaredLen,
    'the contract array length annotation disagrees with its own entries',
  );
  assert.deepEqual(
    [...RESERVED_HANDLES].sort(),
    [...fromContract].sort(),
    'RESERVED_HANDLES has drifted from the contract — update packages/types/src/handle.ts',
  );
});

test('every reserved handle is itself charset-valid', () => {
  // A reserved name that failed validate_handle would be unreachable in the
  // contract, which would mean the list is protecting nothing.
  for (const handle of RESERVED_HANDLES) {
    assert.ok(isValidHandle(handle), `${handle} is reserved but not charset-valid`);
  }
});

test('the contract enforces the same charset this module encodes', () => {
  const validate = contractSource.slice(contractSource.indexOf('fn validate_handle'));
  for (const rule of [
    'is_ascii_lowercase()',
    'is_ascii_digit()',
    "b'_'",
    "b'-'",
  ]) {
    assert.ok(validate.includes(rule), `validate_handle no longer checks ${rule}`);
  }
});

test('isValidHandle accepts the contract charset and rejects everything else', () => {
  assert.ok(isValidHandle('aquawolf'));
  assert.ok(isValidHandle('dev_1-two'));
  assert.ok(isValidHandle('a'));
  assert.ok(isValidHandle('a'.repeat(HANDLE_MAX_LEN)));

  assert.ok(!isValidHandle(''));
  assert.ok(!isValidHandle('a'.repeat(HANDLE_MAX_LEN + 1)));
  assert.ok(!isValidHandle('Not-Valid'));
  assert.ok(!isValidHandle('has space'));
  assert.ok(!isValidHandle('emoji✨'));
});

test('isReservedHandle is an exact match, not a prefix match', () => {
  assert.ok(isReservedHandle('api'));
  assert.ok(isReservedHandle('how-it-works'));

  // Superstrings stay claimable — this mirrors the contract's byte compare.
  assert.ok(!isReservedHandle('apps'));
  assert.ok(!isReservedHandle('apiv2'));
  assert.ok(!isReservedHandle('administrator'));
  assert.ok(!isReservedHandle('profiles'));
});

test('isClaimableHandle rejects reserved names and invalid charsets alike', () => {
  assert.ok(isClaimableHandle('aquawolf'));
  assert.ok(isClaimableHandle('apps'));

  assert.ok(!isClaimableHandle('api'));
  assert.ok(!isClaimableHandle('sitemap'));
  assert.ok(!isClaimableHandle('Not-Valid'));
  assert.ok(!isClaimableHandle(''));
});

test('HANDLE_PATTERN length bound agrees with HANDLE_MAX_LEN', () => {
  // The pattern hardcodes its upper bound; keep it honest if the constant moves.
  assert.ok(HANDLE_PATTERN.test('a'.repeat(HANDLE_MAX_LEN)));
  assert.ok(!HANDLE_PATTERN.test('a'.repeat(HANDLE_MAX_LEN + 1)));
});
