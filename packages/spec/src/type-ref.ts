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
import { xdrText } from './xdr-text.ts';

/**
 * Maximum nesting depth allowed for an `xdr.ScSpecTypeDef` tree (`option`,
 * `result`, `vec`, `map`, `tuple`). Deeply nested type definitions risk stack
 * exhaustion and quadratic blowup in schema/view consumers; `parseContractSpec`
 * rejects entries deeper than this cap as `InterfaceUnreadable`, and
 * `toTypeRef` degrades deeper nodes to `{ type: 'unknown' }`.
 */
export const MAX_TYPE_DEPTH = 32;

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
 * Assert that `def` is nested at most `maxDepth` levels deep.
 *
 * Throws a `RangeError` as soon as a branch exceeds `maxDepth` so an
 * adversarial type tree is rejected without traversing the remaining branches.
 */
export function assertTypeDepth(
  def: xdr.ScSpecTypeDef,
  maxDepth: number = MAX_TYPE_DEPTH,
  currentDepth: number = 0,
): void {
  if (currentDepth > maxDepth) {
    throw new RangeError(`ScSpecTypeDef nesting exceeds maximum depth of ${maxDepth}`);
  }
  const arm = armOf(def);
  if (PRIMITIVE_ARMS[arm] !== undefined) return;
  switch (arm) {
    case 'scSpecTypeOption':
      assertTypeDepth(def.option().valueType(), maxDepth, currentDepth + 1);
      break;
    case 'scSpecTypeResult': {
      const result = def.result();
      assertTypeDepth(result.okType(), maxDepth, currentDepth + 1);
      assertTypeDepth(result.errorType(), maxDepth, currentDepth + 1);
      break;
    }
    case 'scSpecTypeVec':
      assertTypeDepth(def.vec().elementType(), maxDepth, currentDepth + 1);
      break;
    case 'scSpecTypeMap': {
      const map = def.map();
      assertTypeDepth(map.keyType(), maxDepth, currentDepth + 1);
      assertTypeDepth(map.valueType(), maxDepth, currentDepth + 1);
      break;
    }
    case 'scSpecTypeTuple':
      for (const element of def.tuple().valueTypes()) {
        assertTypeDepth(element, maxDepth, currentDepth + 1);
      }
      break;
    default:
      break;
  }
}

/**
 * Convert an `xdr.ScSpecTypeDef` into its flattened `TypeRef`.
 *
 * Covers every arm the pinned SDK defines: the primitive/void arms, the
 * integer family, `bytes_n`, `option`, `result`, `vec`, `map`, `tuple` and
 * `udt`. Unrecognised arms or trees deeper than {@link MAX_TYPE_DEPTH} become
 * `{ type: 'unknown', xdrArm }`.
 *
 * @param def - raw XDR type definition, e.g. from a spec function input.
 * @returns the flattened `TypeRef`; never throws.
 */
export function toTypeRef(def: xdr.ScSpecTypeDef, depth: number = 0): TypeRef {
  const arm = armOf(def);
  if (depth >= MAX_TYPE_DEPTH) {
    return { type: 'unknown', xdrArm: arm };
  }
  const primitive = PRIMITIVE_ARMS[arm];
  if (primitive !== undefined) return primitive;

  try {
    switch (arm) {
      case 'scSpecTypeBytesN':
        return { type: 'bytes_n', n: def.bytesN().n() };
      case 'scSpecTypeOption':
        return { type: 'option', value: toTypeRef(def.option().valueType(), depth + 1) };
      case 'scSpecTypeResult': {
        const result = def.result();
        return {
          type: 'result',
          ok: toTypeRef(result.okType(), depth + 1),
          error: toTypeRef(result.errorType(), depth + 1),
        };
      }
      case 'scSpecTypeVec':
        return { type: 'vec', element: toTypeRef(def.vec().elementType(), depth + 1) };
      case 'scSpecTypeMap': {
        const map = def.map();
        return {
          type: 'map',
          key: toTypeRef(map.keyType(), depth + 1),
          value: toTypeRef(map.valueType(), depth + 1),
        };
      }
      case 'scSpecTypeTuple':
        return {
          type: 'tuple',
          elements: def
            .tuple()
            .valueTypes()
            .map((element) => toTypeRef(element, depth + 1)),
        };
      case 'scSpecTypeUdt':
        return { type: 'named', name: xdrText(def.udt().name()) };
      default:
        return { type: 'unknown', xdrArm: arm };
    }
  } catch {
    return { type: 'unknown', xdrArm: arm };
  }
}
