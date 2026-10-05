/**
 * @file The Types tab's reference, as data (#467, design §2.3).
 *
 * Answers the design note's open question ("how much of the type graph is
 * rendered inline"): every type a function can reach is rendered once, one
 * level deep (its fields, cases or variants), and a nested named type is a
 * link to that type's own entry, never an inline expansion. A chain of
 * struct -> struct -> struct is therefore walked by following links.
 *
 * Types no function reaches are kept, in their own group: the spec does
 * contain them, and hiding them would under-report the interface.
 *
 * Pure, so the grouping, ordering and link targets are testable against a
 * fixture spec with `node:test`. `_docs/type-list.tsx` only lays this out.
 */

import {
  referencedTypes,
  type SpecErrorCase,
  type SpecField,
  type SpecFunction,
  type SpecType,
} from '@signet/spec';
import { typeAnchor } from './anchors.ts';
import { linkedParts, type LinkedPart } from './function-reference.ts';

/** The slice of a decoded spec the Types tab reads; `SpecJson` satisfies it. */
export interface TypeReferenceSpec {
  readonly functions: readonly SpecFunction[];
  readonly types: readonly SpecType[];
  readonly errors: readonly SpecErrorCase[];
}

/** A named, typed member (struct field or union payload field). */
export interface TypeMemberRow {
  readonly name: string;
  readonly type: readonly LinkedPart[];
  /** The contract's own doc comment, or `null`. */
  readonly doc: string | null;
}

export interface UnionCaseRow {
  readonly name: string;
  readonly doc: string | null;
  /** Payload types in order; empty for a unit case. */
  readonly payload: readonly TypeMemberRow[];
}

export interface EnumVariantRow {
  readonly name: string;
  readonly value: number;
  readonly doc: string | null;
}

interface TypeEntryBase {
  readonly name: string;
  /** Fragment id, from the shared anchor helper. */
  readonly id: string;
  readonly doc: string | null;
}

export type TypeEntry =
  | (TypeEntryBase & { readonly kind: 'struct'; readonly fields: readonly TypeMemberRow[] })
  | (TypeEntryBase & { readonly kind: 'union'; readonly cases: readonly UnionCaseRow[] })
  | (TypeEntryBase & { readonly kind: 'enum'; readonly variants: readonly EnumVariantRow[] });

export interface MissingType {
  readonly name: string;
  /** The text between the code-formatted name: before and after. */
  readonly before: string;
  readonly after: string;
}

export interface TypeReference {
  /** Types some function reaches, alphabetical. */
  readonly used: readonly TypeEntry[];
  /** Types defined but unreachable from any function, alphabetical. */
  readonly unused: readonly TypeEntry[];
  /** `Defined but not used by any function (3)`; `null` when there are none. */
  readonly unusedLabel: string | null;
  /** Names a signature reaches that the spec does not define. */
  readonly missing: readonly MissingType[];
  /** True when there is nothing to render: no entries and no dangling reference. */
  readonly isEmpty: boolean;
}

/** Heading of the collapsed group. */
export const UNUSED_TYPES_LABEL = 'Defined but not used by any function';

/** Said on the tab when the interface defines no types at all. */
export const NO_TYPES_NOTE = 'This contract defines no types of its own.';

const MISSING_BEFORE = 'Type ';
const MISSING_AFTER = " is referenced but not defined in this contract's interface";

/** The dangling-reference sentence as plain text (§2.3). */
export function missingTypeMessage(name: string): string {
  return `${MISSING_BEFORE}\`${name}\`${MISSING_AFTER}`;
}

function docOf(doc: string | undefined): string | null {
  return typeof doc === 'string' && doc.trim().length > 0 ? doc : null;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function entry(type: SpecType, names: ReadonlySet<string>, typesHref: string): TypeEntry {
  const base = { name: type.name, id: typeAnchor(type.name), doc: docOf(type.doc) };
  const member = (f: SpecField): TypeMemberRow => ({
    name: f.name,
    type: linkedParts(f.type, names, typesHref),
    doc: docOf(f.doc),
  });
  switch (type.kind) {
    case 'struct':
      return { ...base, kind: 'struct', fields: type.fields.map(member) };
    case 'union':
      return {
        ...base,
        kind: 'union',
        cases: type.cases.map((c) => ({
          name: c.name,
          doc: docOf(c.doc),
          payload: c.fields.map(member),
        })),
      };
    case 'enum':
      return {
        ...base,
        kind: 'enum',
        variants: type.variants.map((v) => ({ name: v.name, value: v.value, doc: docOf(v.doc) })),
      };
  }
}

/**
 * Build the Types tab's reference from a decoded spec.
 *
 * @param spec - the contract's decoded interface.
 * @param typesHref - the Types tab for this contract (`typesTabHref`).
 */
export function buildTypeReference(spec: TypeReferenceSpec, typesHref: string): TypeReference {
  const closure = referencedTypes(spec);
  const reached = new Set(closure.names);

  // First definition wins, matching `referencedTypes`; one id per type.
  const defined = new Map<string, SpecType>();
  for (const type of spec.types) if (!defined.has(type.name)) defined.set(type.name, type);
  const names = new Set(defined.keys());

  const entries = [...defined.values()].sort(byName).map((type) => entry(type, names, typesHref));
  const used = entries.filter((e) => reached.has(e.name));
  const unused = entries.filter((e) => !reached.has(e.name));
  const missing = [...closure.missing]
    .sort()
    .map((name) => ({ name, before: MISSING_BEFORE, after: MISSING_AFTER }));

  return {
    used,
    unused,
    unusedLabel: unused.length > 0 ? `${UNUSED_TYPES_LABEL} (${unused.length})` : null,
    missing,
    isEmpty: entries.length === 0 && missing.length === 0,
  };
}
