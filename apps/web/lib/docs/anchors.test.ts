import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorAnchor, fnAnchor, typeAnchor } from './anchors.ts';

test('a function anchor is the name behind the fn- prefix', () => {
  assert.equal(fnAnchor('claim'), 'fn-claim');
});

test('a type anchor is the name behind the type- prefix', () => {
  assert.equal(typeAnchor('Config'), 'type-Config');
});

test('an error anchor carries the enum and the case', () => {
  assert.equal(errorAnchor('Error', 'HandleTaken'), 'error-Error-HandleTaken');
});

test('a function and a type with the same name get distinct anchors', () => {
  assert.notEqual(fnAnchor('Config'), typeAnchor('Config'));
  assert.equal(fnAnchor('Config'), 'fn-Config');
  assert.equal(typeAnchor('Config'), 'type-Config');
});

test('identifiers pass through unslugged, underscores and case intact', () => {
  assert.equal(fnAnchor('pool_Swap_2'), 'fn-pool_Swap_2');
  assert.equal(errorAnchor('Err_A', 'Not_Found'), 'error-Err_A-Not_Found');
});
