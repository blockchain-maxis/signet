import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrimitiveType, TypeRef } from '@signet/spec';
import { formatTypeRef, typeRefParts } from './format-type.ts';

test('every primitive renders its Rust spelling', () => {
  const expected: Record<PrimitiveType, string> = {
    val: 'Val',
    void: '()',
    bool: 'bool',
    i32: 'i32',
    u32: 'u32',
    i64: 'i64',
    u64: 'u64',
    i128: 'i128',
    u128: 'u128',
    i256: 'I256',
    u256: 'U256',
    bytes: 'Bytes',
    string: 'String',
    symbol: 'Symbol',
    address: 'Address',
    muxedAddress: 'MuxedAddress',
    timepoint: 'Timepoint',
    duration: 'Duration',
    error: 'Error',
  };
  for (const [primitive, spelling] of Object.entries(expected)) {
    assert.equal(formatTypeRef(primitive as PrimitiveType), spelling);
  }
});

test('bytes_n renders BytesN<N>', () => {
  assert.equal(formatTypeRef({ type: 'bytes_n', n: 32 }), 'BytesN<32>');
});

test('option, vec, map and result render generics', () => {
  assert.equal(formatTypeRef({ type: 'option', value: 'u32' }), 'Option<u32>');
  assert.equal(formatTypeRef({ type: 'vec', element: 'address' }), 'Vec<Address>');
  assert.equal(formatTypeRef({ type: 'map', key: 'symbol', value: 'i128' }), 'Map<Symbol, i128>');
  assert.equal(formatTypeRef({ type: 'result', ok: 'void', error: 'error' }), 'Result<(), Error>');
});

test('tuples render with parentheses', () => {
  assert.equal(formatTypeRef({ type: 'tuple', elements: [] }), '()');
  assert.equal(formatTypeRef({ type: 'tuple', elements: ['u32'] }), '(u32,)');
  assert.equal(
    formatTypeRef({ type: 'tuple', elements: ['u32', 'string', 'bool'] }),
    '(u32, String, bool)',
  );
});

test('named renders the UDT name', () => {
  assert.equal(formatTypeRef({ type: 'named', name: 'MyStruct' }), 'MyStruct');
});

test('unknown renders the unreadable placeholder with its arm', () => {
  assert.equal(
    formatTypeRef({ type: 'unknown', xdrArm: 'scSpecTypeFuture' }),
    '<unreadable type: scSpecTypeFuture>',
  );
});

test('nested types render', () => {
  const nested: TypeRef = {
    type: 'map',
    key: 'symbol',
    value: {
      type: 'vec',
      element: { type: 'option', value: { type: 'named', name: 'MyStruct' } },
    },
  };
  assert.equal(formatTypeRef(nested), 'Map<Symbol, Vec<Option<MyStruct>>>');
  assert.equal(
    formatTypeRef({
      type: 'tuple',
      elements: [
        { type: 'vec', element: 'address' },
        { type: 'tuple', elements: ['u32', { type: 'bytes_n', n: 4 }] },
      ],
    }),
    '(Vec<Address>, (u32, BytesN<4>))',
  );
});

test('typeRefParts marks only named UDT tokens', () => {
  const t: TypeRef = {
    type: 'result',
    ok: { type: 'vec', element: { type: 'named', name: 'Entry' } },
    error: { type: 'named', name: 'Failure' },
  };
  const parts = typeRefParts(t);
  assert.deepEqual(
    parts.filter((p) => p.udt).map((p) => p.text),
    ['Entry', 'Failure'],
  );
  assert.equal(parts.map((p) => p.text).join(''), formatTypeRef(t));
  assert.ok(typeRefParts('u32').every((p) => !p.udt));
});
