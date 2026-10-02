import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr } from '@stellar/stellar-sdk';
import { buildFunctions, buildSpecViews } from './views.ts';
import { toTypeRef } from './type-ref.ts';
import { fixtureEntries } from './test-helpers.ts';

test('registry fixture: 8 documented functions and 7 errors with their values', () => {
  const { functions, types, errors } = buildSpecViews(fixtureEntries('identity-registry'));
  assert.equal(functions.length, 8);
  assert.ok(functions.every((f) => f.doc.length > 0));
  assert.ok(functions.every((f) => !f.isConstructor));
  assert.deepEqual(
    functions.map((f) => f.name),
    ['claim', 'count', 'lookup', 'release', 'resolve', 'is_bound', 'initialize', 'admin_revoke'],
  );
  assert.deepEqual(types, []);
  assert.deepEqual(
    errors.map((e) => [e.name, e.value]),
    [
      ['AlreadyInitialized', 1],
      ['NotInitialized', 2],
      ['HandleTaken', 3],
      ['HandleNotFound', 4],
      ['NotOwner', 5],
      ['InvalidHandle', 6],
      ['WalletAlreadyBound', 7],
    ],
  );
  assert.ok(errors.every((e) => e.enumName === 'Error' && typeof e.doc === 'string'));
});

test('undocumented fixture: doc is the empty string, never undefined', () => {
  const { functions } = buildSpecViews(fixtureEntries('undocumented'));
  assert.equal(functions.length, 3);
  for (const f of functions) {
    assert.equal(f.doc, '');
    for (const input of f.inputs) assert.equal(input.doc, '');
  }
});

test('errors_multi fixture: two enum groups, not merged', () => {
  const { errors } = buildSpecViews(fixtureEntries('errors_multi'));
  assert.deepEqual(
    errors.map((e) => `${e.enumName}.${e.name}=${e.value}`),
    ['AuthError.Denied=1', 'AuthError.Expired=2', 'StoreError.Missing=1', 'StoreError.Invalid=2'],
  );
  assert.deepEqual([...new Set(errors.map((e) => e.enumName))], ['AuthError', 'StoreError']);
});

test('types_zoo fixture: struct, union and enum views in declaration order', () => {
  const { types, errors } = buildSpecViews(fixtureEntries('types_zoo'));
  assert.deepEqual(
    types.map((t) => [t.kind, t.name]),
    [
      ['enum', 'Color'],
      ['union', 'Shape'],
      ['struct', 'Level1'],
      ['struct', 'Level2'],
      ['struct', 'Level3'],
    ],
  );
  const color = types[0]!;
  assert.ok(color.kind === 'enum');
  assert.deepEqual(
    color.variants.map((v) => [v.name, v.value]),
    [
      ['Red', 1],
      ['Green', 2],
    ],
  );
  const shape = types[1]!;
  assert.ok(shape.kind === 'union');
  assert.deepEqual(shape.cases[0]!.fields, [
    { name: '0', type: 'u32' },
    { name: '1', type: 'u32' },
  ]);
  assert.deepEqual(shape.cases[1]!.fields, []);
  assert.deepEqual(
    errors.map((e) => e.enumName),
    ['ZooError'],
  );
});

test('types_zoo fixture: every function signature converts without unknown arms', () => {
  const functions = buildFunctions(fixtureEntries('types_zoo'));
  const seen = JSON.stringify(functions);
  assert.ok(!seen.includes('"unknown"'));
  const blobs = functions.find((f) => f.name === 'blobs')!;
  assert.deepEqual(
    blobs.inputs.map((i) => i.type),
    ['string', 'symbol', 'bytes', { type: 'bytes_n', n: 32 }],
  );
});

test('a constructor is kept in functions and flagged', () => {
  const ctor = xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({ doc: '', name: '__constructor', inputs: [], outputs: [] }),
  );
  const other = xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({ doc: 'Hi', name: 'hello', inputs: [], outputs: [] }),
  );
  const fns = buildFunctions([ctor, other]);
  assert.deepEqual(
    fns.map((f) => [f.name, f.isConstructor]),
    [
      ['__constructor', true],
      ['hello', false],
    ],
  );
});

test('an arm this converter does not know becomes an unknown TypeRef', () => {
  // A future SDK arm, not a real one: muxed addresses are a primitive now.
  const futureArm = {
    switch: () => ({ name: 'scSpecTypeFutureArm' }),
  } as unknown as xdr.ScSpecTypeDef;
  assert.deepEqual(toTypeRef(futureArm), { type: 'unknown', xdrArm: 'scSpecTypeFutureArm' });
});
