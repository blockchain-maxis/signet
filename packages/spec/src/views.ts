/**
 * @file @signet/spec
 *
 * Flattened `functions`, `types` and `errors` views over decoded
 * `ScSpecEntry` values (§2.3 of docs/CONTRACT_DOCS_DESIGN.md). Every view keeps
 * declaration order and never leaves `doc` undefined.
 */

import type { xdr } from '@stellar/stellar-sdk';
import { toTypeRef } from './type-ref.ts';
import { xdrText } from './xdr-text.ts';
import type { SpecErrorCase, SpecField, SpecFunction, SpecType } from './types.ts';

/** Name the Soroban SDK gives a contract's constructor function. */
export const CONSTRUCTOR_NAME = '__constructor';

/** `functionV0` entries as `SpecFunction`s, in declaration order. */
export function buildFunctions(entries: readonly xdr.ScSpecEntry[]): SpecFunction[] {
  const out: SpecFunction[] = [];
  for (const entry of entries) {
    if (entry.switch().name !== 'scSpecEntryFunctionV0') continue;
    const fn = entry.functionV0();
    const name = xdrText(fn.name());
    out.push({
      name,
      doc: xdrText(fn.doc()),
      isConstructor: name === CONSTRUCTOR_NAME,
      inputs: fn.inputs().map(
        (input): SpecField => ({
          name: xdrText(input.name()),
          doc: xdrText(input.doc()),
          type: toTypeRef(input.type()),
        }),
      ),
      outputs: fn.outputs().map(toTypeRef),
    });
  }
  return out;
}

/** `udtStructV0`, `udtUnionV0` and `udtEnumV0` entries as `SpecType`s. */
export function buildTypes(entries: readonly xdr.ScSpecEntry[]): SpecType[] {
  const out: SpecType[] = [];
  for (const entry of entries) {
    switch (entry.switch().name) {
      case 'scSpecEntryUdtStructV0': {
        const s = entry.udtStructV0();
        out.push({
          kind: 'struct',
          name: xdrText(s.name()),
          doc: xdrText(s.doc()),
          fields: s.fields().map(
            (f): SpecField => ({
              name: xdrText(f.name()),
              doc: xdrText(f.doc()),
              type: toTypeRef(f.type()),
            }),
          ),
        });
        break;
      }
      case 'scSpecEntryUdtUnionV0': {
        const u = entry.udtUnionV0();
        out.push({
          kind: 'union',
          name: xdrText(u.name()),
          doc: xdrText(u.doc()),
          cases: u.cases().map((c) => {
            if (c.switch().name === 'scSpecUdtUnionCaseTupleV0') {
              const t = c.tupleCase();
              return {
                name: xdrText(t.name()),
                doc: xdrText(t.doc()),
                // Tuple payloads are positional, so fields are named by index.
                fields: t
                  .type()
                  .map((type, i): SpecField => ({ name: String(i), type: toTypeRef(type) })),
              };
            }
            const v = c.voidCase();
            return { name: xdrText(v.name()), doc: xdrText(v.doc()), fields: [] };
          }),
        });
        break;
      }
      case 'scSpecEntryUdtEnumV0': {
        const e = entry.udtEnumV0();
        out.push({
          kind: 'enum',
          name: xdrText(e.name()),
          doc: xdrText(e.doc()),
          variants: e.cases().map((c) => ({
            name: xdrText(c.name()),
            doc: xdrText(c.doc()),
            value: c.value(),
          })),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * Every case of every `udtErrorEnumV0`, in declaration order. Cases keep the
 * `enumName` of the enum that declared them; enums are never merged. (The SDK's
 * `Spec.errorCases()` flattens across enums and loses that grouping.)
 */
export function buildErrors(entries: readonly xdr.ScSpecEntry[]): SpecErrorCase[] {
  const out: SpecErrorCase[] = [];
  for (const entry of entries) {
    if (entry.switch().name !== 'scSpecEntryUdtErrorEnumV0') continue;
    const en = entry.udtErrorEnumV0();
    const enumName = xdrText(en.name());
    for (const c of en.cases()) {
      out.push({
        enumName,
        name: xdrText(c.name()),
        value: c.value(),
        doc: xdrText(c.doc()),
      });
    }
  }
  return out;
}

/** The three flattened views of one decoded spec. */
export function buildSpecViews(entries: readonly xdr.ScSpecEntry[]): {
  functions: SpecFunction[];
  types: SpecType[];
  errors: SpecErrorCase[];
} {
  return {
    functions: buildFunctions(entries),
    types: buildTypes(entries),
    errors: buildErrors(entries),
  };
}
