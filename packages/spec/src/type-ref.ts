/**
 * @file @signet/spec
 *
 * Total conversion from the raw `xdr.ScSpecTypeDef` union to the flattened
 * `TypeRef` model.
 *
 * Every consumer renders types, so one conversion covering every XDR arm means
 * no consumer has to switch on raw XDR. The conversion is total: it never
 * throws. An arm the pinned SDK does not recognise — or a def whose payload is
 * malformed — maps to `{ type: 'unknown', xdrArm }` instead of raising, so a
 * future SDK arm degrades to a visible fallback rather than a crash.
 */

import type { xdr } from '@stellar/stellar-sdk';
import type { PrimitiveType, TypeRef } from './types.ts';

/**
 * Switch-name → primitive literal for every void arm of `xdr.ScSpecTypeDef`.
 *
 * Most of this table mirrors Orbital's primitive set. Four entries are Signet
 * extensions — primitives outside Orbital's set that exist so every pinned-SDK
 * arm has a first-class `TypeRef`:
 *
 * - `'val'` — the untyped `Val` host value
 * - `'timepoint'` — absolute ledger time
 * - `'duration'` — a relative time span
 * - `'muxedAddress'` — muxed (`M...`) account address
 *
 * A consumer mapping `TypeRef` onto an Orbital ABI must handle these four
 * itself (tracked as #439).
 */
const PRIMITIVE_ARMS: Readonly<Record<string, PrimitiveType>> = {
  scSpecTypeVal: 'val',
  scSpecTypeBool: 'bool',
  scSpecTypeVoid: 'void',
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
  scSpecTypeMuxedAddress: 'muxedAddress',
};

/**
 * Read the arm discriminator without letting a malformed def escape.
 *
 * @param def - union to inspect.
 * @returns the `xdr.ScSpecType` switch name, or `'unknown'` if unreadable.
 */
function armOf(def: xdr.ScSpecTypeDef): string {
  try {
    return def.switch().name;
  } catch {
    return 'unknown';
  }
}

/**
 * Convert an `xdr.ScSpecTypeDef` into its flattened `TypeRef`.
 *
 * Covers every arm the pinned SDK defines: the primitive/void arms, the
 * integer family, `bytes_n`, `option`, `result`, `vec`, `map`, `tuple` and
 * `udt`. Unrecognised arms become `{ type: 'unknown', xdrArm }`.
 *
 * @param def - raw XDR type definition, e.g. from a spec function input.
 * @returns the flattened `TypeRef`; never throws.
 */
export function toTypeRef(def: xdr.ScSpecTypeDef): TypeRef {
  const arm = armOf(def);
  const primitive = PRIMITIVE_ARMS[arm];
  if (primitive !== undefined) return primitive;

  try {
    switch (arm) {
      case 'scSpecTypeBytesN':
        return { type: 'bytes_n', n: def.bytesN().n() };
      case 'scSpecTypeOption':
        return { type: 'option', value: toTypeRef(def.option().valueType()) };
      case 'scSpecTypeResult': {
        const result = def.result();
        return {
          type: 'result',
          ok: toTypeRef(result.okType()),
          error: toTypeRef(result.errorType()),
        };
      }
      case 'scSpecTypeVec':
        return { type: 'vec', element: toTypeRef(def.vec().elementType()) };
      case 'scSpecTypeMap': {
        const map = def.map();
        return {
          type: 'map',
          key: toTypeRef(map.keyType()),
          value: toTypeRef(map.valueType()),
        };
      }
      case 'scSpecTypeTuple':
        return {
          type: 'tuple',
          elements: def
            .tuple()
            .valueTypes()
            .map((element) => toTypeRef(element)),
        };
      case 'scSpecTypeUdt':
        return { type: 'named', name: String(def.udt().name()) };
      default:
        return { type: 'unknown', xdrArm: arm };
    }
  } catch {
    return { type: 'unknown', xdrArm: arm };
  }
}
