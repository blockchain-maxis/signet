import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contract, xdr } from '@stellar/stellar-sdk';
import { toTypeRef } from './type-ref.ts';
import type { TypeRef } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

/** One function's converted signature: ordered inputs and outputs. */
interface FnSnapshot {
  readonly inputs: readonly (readonly [string, TypeRef])[];
  readonly outputs: readonly TypeRef[];
}

/**
 * Inline snapshot of every `types_zoo.wasm` function input and output after
 * conversion. Derived from `fixture-contracts/types_zoo/src/lib.rs`: the
 * integers, bool, text/binary primitives, address, ledger time, option,
 * result, vec, map, tuple, the three-level struct, both enums, and the void
 * function (whose spec carries no outputs at all).
 */
const EXPECTED_TYPES_ZOO: Readonly<Record<string, FnSnapshot>> = {
  ints: {
    inputs: [
      ['a', 'u32'],
      ['b', 'i32'],
      ['c', 'u64'],
      ['d', 'i64'],
      ['e', 'u128'],
      ['f', 'i128'],
      ['g', 'u256'],
      ['h', 'i256'],
    ],
    outputs: ['u32'],
  },
  flip: { inputs: [['v', 'bool']], outputs: ['bool'] },
  blobs: {
    inputs: [
      ['s', 'string'],
      ['sym', 'symbol'],
      ['b', 'bytes'],
      ['fixed', { type: 'bytes_n', n: 32 }],
    ],
    outputs: ['bytes'],
  },
  who: { inputs: [['who', 'address']], outputs: ['address'] },
  when: {
    inputs: [
      ['at', 'timepoint'],
      ['lasts', 'duration'],
    ],
    outputs: ['timepoint'],
  },
  maybe: {
    inputs: [['v', { type: 'option', value: 'u32' }]],
    outputs: [{ type: 'option', value: 'u32' }],
  },
  fallible: {
    inputs: [['v', { type: 'result', ok: 'u32', error: { type: 'named', name: 'ZooError' } }]],
    outputs: [{ type: 'result', ok: 'u32', error: { type: 'named', name: 'ZooError' } }],
  },
  many: {
    inputs: [['v', { type: 'vec', element: 'u32' }]],
    outputs: [{ type: 'vec', element: 'u32' }],
  },
  lookup: {
    inputs: [['m', { type: 'map', key: 'symbol', value: 'u32' }]],
    outputs: [{ type: 'map', key: 'symbol', value: 'u32' }],
  },
  pair: {
    inputs: [['p', { type: 'tuple', elements: ['u32', 'symbol'] }]],
    outputs: [{ type: 'tuple', elements: ['u32', 'symbol'] }],
  },
  nested: {
    inputs: [['v', { type: 'named', name: 'Level1' }]],
    outputs: [{ type: 'named', name: 'Level1' }],
  },
  paint: {
    inputs: [['c', { type: 'named', name: 'Color' }]],
    outputs: [{ type: 'named', name: 'Color' }],
  },
  shape: {
    inputs: [['s', { type: 'named', name: 'Shape' }]],
    outputs: [{ type: 'named', name: 'Shape' }],
  },
  noop: { inputs: [], outputs: [] },
};

/** Every `ScSpecType` arm the pinned SDK (16.x) defines. */
const SDK_ARMS: readonly string[] = [
  'scSpecTypeVal',
  'scSpecTypeBool',
  'scSpecTypeVoid',
  'scSpecTypeError',
  'scSpecTypeU32',
  'scSpecTypeI32',
  'scSpecTypeU64',
  'scSpecTypeI64',
  'scSpecTypeTimepoint',
  'scSpecTypeDuration',
  'scSpecTypeU128',
  'scSpecTypeI128',
  'scSpecTypeU256',
  'scSpecTypeI256',
  'scSpecTypeBytes',
  'scSpecTypeString',
  'scSpecTypeSymbol',
  'scSpecTypeAddress',
  'scSpecTypeMuxedAddress',
  'scSpecTypeOption',
  'scSpecTypeResult',
  'scSpecTypeVec',
  'scSpecTypeMap',
  'scSpecTypeTuple',
  'scSpecTypeBytesN',
  'scSpecTypeUdt',
];

/**
 * `xdr.ScSpecType.values()` exists at runtime (js-xdr enum) but is not in the
 * generated declarations, hence the narrow cast.
 */
function scSpecTypeValues(): xdr.ScSpecType[] {
  return (xdr.ScSpecType as unknown as { values(): xdr.ScSpecType[] }).values();
}

/**
 * Build a representative `ScSpecTypeDef` for an arbitrary switch member.
 * Value-carrying arms get a minimal well-formed payload; void arms use the
 * generated static factory (also the path a future arm falls through to).
 */
function sampleDef(sw: xdr.ScSpecType): xdr.ScSpecTypeDef {
  const bool = xdr.ScSpecTypeDef.scSpecTypeBool();
  switch (sw.name) {
    case 'scSpecTypeBytesN':
      return xdr.ScSpecTypeDef.scSpecTypeBytesN(new xdr.ScSpecTypeBytesN({ n: 32 }));
    case 'scSpecTypeOption':
      return xdr.ScSpecTypeDef.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType: bool }));
    case 'scSpecTypeResult':
      return xdr.ScSpecTypeDef.scSpecTypeResult(
        new xdr.ScSpecTypeResult({ okType: bool, errorType: bool }),
      );
    case 'scSpecTypeVec':
      return xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType: bool }));
    case 'scSpecTypeMap':
      return xdr.ScSpecTypeDef.scSpecTypeMap(
        new xdr.ScSpecTypeMap({ keyType: bool, valueType: bool }),
      );
    case 'scSpecTypeTuple':
      return xdr.ScSpecTypeDef.scSpecTypeTuple(new xdr.ScSpecTypeTuple({ valueTypes: [bool] }));
    case 'scSpecTypeUdt':
      return xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name: 'Zoo' }));
    default: {
      const factory = (xdr.ScSpecTypeDef as unknown as Record<string, () => xdr.ScSpecTypeDef>)[
        sw.name
      ];
      assert.ok(factory, `sample builder knows arm ${sw.name}`);
      return factory();
    }
  }
}

/** Decode a fixture's `contractspecv0` section into raw function entries. */
function loadFunctions(fixture: string): xdr.ScSpecFunctionV0[] {
  const wasm = readFileSync(join(FIXTURES_DIR, fixture));
  const module = new WebAssembly.Module(wasm);
  const [section] = WebAssembly.Module.customSections(module, 'contractspecv0');
  assert.ok(section, `${fixture} carries a contractspecv0 section`);
  return new contract.Spec(Buffer.from(section)).funcs();
}

test('toTypeRef converts every types_zoo.wasm input and output (inline snapshot)', () => {
  const actual: Record<string, FnSnapshot> = {};
  for (const fn of loadFunctions('types_zoo.wasm')) {
    const name = String(fn.name());
    actual[name] = {
      inputs: fn.inputs().map((input) => [String(input.name()), toTypeRef(input.type())] as const),
      outputs: fn.outputs().map((output) => toTypeRef(output)),
    };
  }

  assert.deepEqual(actual, EXPECTED_TYPES_ZOO);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(EXPECTED_TYPES_ZOO).sort());
});

test('every xdr.ScSpecType arm converts without throwing (exhaustiveness)', () => {
  const seen: string[] = [];
  for (const sw of scSpecTypeValues()) {
    const ref = toTypeRef(sampleDef(sw));
    assert.ok(ref !== undefined && ref !== null, `${sw.name} produced a TypeRef`);
    if (typeof ref === 'object') {
      assert.notEqual(ref.type, 'unknown', `${sw.name} must convert, not fall through to unknown`);
    }
    seen.push(sw.name);
  }

  // An SDK upgrade that adds an arm fails here instead of on a page.
  assert.deepEqual([...seen].sort(), [...SDK_ARMS].sort());
});

test('unrecognised arms map to unknown and never throw', () => {
  const futureArm = {
    switch: () => ({ name: 'scSpecTypeFutureArm' }),
  } as unknown as xdr.ScSpecTypeDef;
  assert.deepEqual(toTypeRef(futureArm), { type: 'unknown', xdrArm: 'scSpecTypeFutureArm' });

  const unreadable = null as unknown as xdr.ScSpecTypeDef;
  assert.deepEqual(toTypeRef(unreadable), { type: 'unknown', xdrArm: 'unknown' });

  const malformedPayload = {
    switch: () => ({ name: 'scSpecTypeOption' }),
    option: () => ({}),
  } as unknown as xdr.ScSpecTypeDef;
  assert.deepEqual(toTypeRef(malformedPayload), { type: 'unknown', xdrArm: 'scSpecTypeOption' });
});
