/**
 * @file @signet/spec
 *
 * Minimal `xdr.ScSpecTypeDef` -> `TypeRef` conversion used by the flattened
 * views. Unrecognised arms become `{ type: 'unknown', xdrArm }` instead of
 * throwing, so a newer SDK arm is visible rather than dropped.
 */

import type { xdr } from '@stellar/stellar-sdk';
import type { PrimitiveType, TypeRef } from './types.ts';

const PRIMITIVES: Readonly<Record<string, PrimitiveType>> = {
  scSpecTypeVal: 'val',
  scSpecTypeVoid: 'void',
  scSpecTypeBool: 'bool',
  scSpecTypeError: 'error',
  scSpecTypeU32: 'u32',
  scSpecTypeI32: 'i32',
  scSpecTypeU64: 'u64',
  scSpecTypeI64: 'i64',
  scSpecTypeTimepoint: 'timepoint',
  scSpecTypeDuration: 'duration',
  scSpecTypeU128: 'u128',
  scSpecTypeI128: 'i128',
  scSpecTypeU256: 'u256',
  scSpecTypeI256: 'i256',
  scSpecTypeBytes: 'bytes',
  scSpecTypeString: 'string',
  scSpecTypeSymbol: 'symbol',
  scSpecTypeAddress: 'address',
};

/** Decode an XDR `string | Buffer` field to a JS string. */
export function xdrText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

/** Convert an XDR type definition to the public `TypeRef` shape. */
export function typeDefToRef(def: xdr.ScSpecTypeDef): TypeRef {
  const arm = def.switch().name;
  const primitive = PRIMITIVES[arm];
  if (primitive !== undefined) return primitive;

  switch (arm) {
    case 'scSpecTypeOption':
      return { type: 'option', value: typeDefToRef(def.option().valueType()) };
    case 'scSpecTypeResult':
      return {
        type: 'result',
        ok: typeDefToRef(def.result().okType()),
        error: typeDefToRef(def.result().errorType()),
      };
    case 'scSpecTypeVec':
      return { type: 'vec', element: typeDefToRef(def.vec().elementType()) };
    case 'scSpecTypeMap':
      return {
        type: 'map',
        key: typeDefToRef(def.map().keyType()),
        value: typeDefToRef(def.map().valueType()),
      };
    case 'scSpecTypeTuple':
      return { type: 'tuple', elements: def.tuple().valueTypes().map(typeDefToRef) };
    case 'scSpecTypeBytesN':
      return { type: 'bytes_n', n: def.bytesN().n() };
    case 'scSpecTypeUdt':
      return { type: 'named', name: xdrText(def.udt().name()) };
    default:
      return { type: 'unknown', xdrArm: arm };
  }
}
