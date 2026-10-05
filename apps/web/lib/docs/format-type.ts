/**
 * @file Render a `TypeRef` as a readable signature (#465).
 *
 * Every docs surface prints types, and readers know Soroban types in their
 * Rust spelling (`Option<Vec<Address>>`, `BytesN<32>`, `Result<(), Error>`).
 * One pure function keeps that spelling consistent across the reference, the
 * permalinks and the stubs.
 *
 * `typeRefParts` is the structured form: a flat token list that marks which
 * tokens are named UDTs, so a renderer can link them without parsing the
 * string. `formatTypeRef` is that list joined, so the two never disagree.
 */

import type { PrimitiveType, TypeRef } from '@signet/spec';

/** One piece of a rendered type. `udt` is true only for named UDT tokens. */
export interface TypePart {
  readonly text: string;
  readonly udt: boolean;
}

/** Rust spelling of every primitive; `void` is the unit type. */
const PRIMITIVE_SPELLING: Readonly<Record<PrimitiveType, string>> = {
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

/** Plain punctuation or keyword token. */
function text(value: string): TypePart {
  return { text: value, udt: false };
}

/** `name<a, b>` as tokens. */
function generic(name: string, args: readonly TypeRef[]): TypePart[] {
  const parts: TypePart[] = [text(`${name}<`)];
  args.forEach((arg, i) => {
    if (i > 0) parts.push(text(', '));
    parts.push(...typeRefParts(arg));
  });
  parts.push(text('>'));
  return parts;
}

/**
 * Tokenise a `TypeRef` in Rust spelling.
 *
 * @param t - type reference to render.
 * @returns ordered tokens; concatenating their `text` gives `formatTypeRef`.
 */
export function typeRefParts(t: TypeRef): TypePart[] {
  if (typeof t === 'string') return [text(PRIMITIVE_SPELLING[t])];
  switch (t.type) {
    case 'bytes_n':
      return [text(`BytesN<${t.n}>`)];
    case 'option':
      return generic('Option', [t.value]);
    case 'result':
      return generic('Result', [t.ok, t.error]);
    case 'vec':
      return generic('Vec', [t.element]);
    case 'map':
      return generic('Map', [t.key, t.value]);
    case 'tuple': {
      const parts: TypePart[] = [text('(')];
      t.elements.forEach((element, i) => {
        if (i > 0) parts.push(text(', '));
        parts.push(...typeRefParts(element));
      });
      // Rust spells a one-element tuple with a trailing comma.
      if (t.elements.length === 1) parts.push(text(','));
      parts.push(text(')'));
      return parts;
    }
    case 'named':
      return [{ text: t.name, udt: true }];
    case 'unknown':
      return [text(`<unreadable type: ${t.xdrArm}>`)];
  }
}

/**
 * Render a `TypeRef` as a Rust-style signature string.
 *
 * @param t - type reference to render.
 * @returns e.g. `Map<Symbol, Vec<Option<MyStruct>>>`.
 */
export function formatTypeRef(t: TypeRef): string {
  return typeRefParts(t)
    .map((part) => part.text)
    .join('');
}
