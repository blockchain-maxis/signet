/**
 * @file The Functions tab's reference, as data (#466, design §2.3).
 *
 * One section per exported function: its name, doc comment, typed arguments
 * and return type. The signature is documentation, so a function with no doc
 * comment still renders in full and nothing here writes prose for it.
 *
 * The view model is pure so the section count, the signature text and every
 * link target are testable against a fixture spec with `node:test`, without a
 * render. `_docs/function-list.tsx` only lays this out.
 *
 * Linking rule: a named type links to its entry on the Types tab only when
 * the spec defines that type. A name the spec does not define (an error enum
 * lives in `errors`, a dangling reference is the contract's own) stays plain
 * text, because a link to an id that is not on the page is worse than none.
 */

import type { SpecErrorCase, SpecFunction, SpecType, TypeRef } from '@signet/spec';
import { contractTabSegmentHref } from '../contract-tabs.ts';
import { fnAnchor, typeAnchor } from './anchors.ts';
import { typeRefParts } from './format-type.ts';
import { ERROR_SCOPE_NOTE, functionReturnsError } from './function-permalink.ts';

/** The slice of a decoded spec the reference reads; `SpecJson` satisfies it. */
export interface FunctionReferenceSpec {
  readonly functions: readonly SpecFunction[];
  readonly types: readonly Pick<SpecType, 'name'>[];
  readonly errors: readonly SpecErrorCase[];
}

/** One token of a rendered type or signature; `href` is set only for a linkable named type. */
export interface LinkedPart {
  readonly text: string;
  readonly href?: string;
}

export interface ReferenceArgument {
  readonly name: string;
  readonly type: readonly LinkedPart[];
}

/** One error enum the contract defines, with its cases. */
export interface ReferenceErrorEnum {
  readonly name: string;
  readonly cases: readonly { readonly name: string; readonly value: number }[];
}

/** The "Can fail with" line. Present only when the return type carries an error. */
export interface ReferenceCanFail {
  /** The contract's error enums; empty when the contract defines none. */
  readonly enums: readonly ReferenceErrorEnum[];
  /** What the list is allowed to claim: the spec has no per-function mapping. */
  readonly note: string;
}

export interface FunctionSection {
  readonly name: string;
  /** Fragment id, from the shared anchor helper. */
  readonly id: string;
  readonly isConstructor: boolean;
  /** `claim(handle: String, wallet: Address) -> Result<(), Error>`, with named types as link tokens. */
  readonly signature: readonly LinkedPart[];
  /** The signature as plain text. */
  readonly signatureText: string;
  /** The contract's own doc comment, or `null` when it has none. */
  readonly doc: string | null;
  readonly args: readonly ReferenceArgument[];
  readonly canFail: ReferenceCanFail | null;
}

export interface FunctionReference {
  /** The constructor, shown in its own subsection; `null` when the contract has none. */
  readonly ctor: FunctionSection | null;
  /** Every other function, in declaration order. */
  readonly functions: readonly FunctionSection[];
}

/** Said under the constructor. It is a fact about Soroban, not about this contract. */
export const CONSTRUCTOR_NOTE = 'The constructor runs once, when the contract is deployed.';

/** Types tab for one contract, the base of every named-type link. */
export function typesTabHref(handle: string, address: string): string {
  return contractTabSegmentHref(handle, address, 'types');
}

/** A `TypeRef` as link tokens. */
function linkedParts(
  ref: TypeRef,
  typeNames: ReadonlySet<string>,
  typesHref: string,
): LinkedPart[] {
  return typeRefParts(ref).map((part) =>
    part.udt && typeNames.has(part.text)
      ? { text: part.text, href: `${typesHref}#${typeAnchor(part.text)}` }
      : { text: part.text },
  );
}

function joined(groups: readonly (readonly LinkedPart[])[], separator: string): LinkedPart[] {
  return groups.flatMap((group, i) => (i === 0 ? [...group] : [{ text: separator }, ...group]));
}

function returnParts(
  fn: SpecFunction,
  typeNames: ReadonlySet<string>,
  typesHref: string,
): LinkedPart[] {
  const outputs = fn.outputs.map((out) => linkedParts(out, typeNames, typesHref));
  if (outputs.length === 0) return [{ text: '()' }];
  if (outputs.length === 1) return outputs[0]!;
  return [{ text: '(' }, ...joined(outputs, ', '), { text: ')' }];
}

function errorEnums(errors: readonly SpecErrorCase[]): ReferenceErrorEnum[] {
  const byEnum = new Map<string, { name: string; value: number }[]>();
  for (const error of errors) {
    const cases = byEnum.get(error.enumName) ?? [];
    cases.push({ name: error.name, value: error.value });
    byEnum.set(error.enumName, cases);
  }
  return [...byEnum].map(([name, cases]) => ({ name, cases }));
}

/**
 * Whether the return type can carry a failure: the primitive `error` type, or
 * a named type that is one of the contract's error enums (what a
 * `#[contracterror]` return compiles to). A named type is only an error enum
 * when the spec says so, never from its spelling.
 */
function returnsError(fn: SpecFunction, errors: readonly SpecErrorCase[]): boolean {
  if (functionReturnsError(fn)) return true;
  const enums = new Set(errors.map((e) => e.enumName));
  return fn.outputs.some((out) => typeRefParts(out).some((p) => p.udt && enums.has(p.text)));
}

/** True when a doc comment carries text; `''` and whitespace-only are absent. */
function hasDoc(doc: string | undefined): doc is string {
  return typeof doc === 'string' && doc.trim().length > 0;
}

function section(
  fn: SpecFunction,
  spec: FunctionReferenceSpec,
  typeNames: ReadonlySet<string>,
  typesHref: string,
): FunctionSection {
  const args: ReferenceArgument[] = fn.inputs.map((input) => ({
    name: input.name,
    type: linkedParts(input.type, typeNames, typesHref),
  }));
  const signature: LinkedPart[] = [
    { text: `${fn.name}(` },
    ...joined(
      args.map((arg) => [{ text: `${arg.name}: ` }, ...arg.type]),
      ', ',
    ),
    { text: ') -> ' },
    ...returnParts(fn, typeNames, typesHref),
  ];
  return {
    name: fn.name,
    id: fnAnchor(fn.name),
    isConstructor: fn.isConstructor,
    signature,
    signatureText: signature.map((part) => part.text).join(''),
    doc: hasDoc(fn.doc) ? fn.doc : null,
    args,
    canFail: returnsError(fn, spec.errors)
      ? { enums: errorEnums(spec.errors), note: ERROR_SCOPE_NOTE }
      : null,
  };
}

/**
 * Build the Functions tab's reference from a decoded spec.
 *
 * @param spec - the contract's decoded interface.
 * @param typesHref - the Types tab for this contract (`typesTabHref`).
 */
export function buildFunctionReference(
  spec: FunctionReferenceSpec,
  typesHref: string,
): FunctionReference {
  const typeNames = new Set(spec.types.map((type) => type.name));
  const sections = spec.functions.map((fn) => section(fn, spec, typeNames, typesHref));
  return {
    ctor: sections.find((s) => s.isConstructor) ?? null,
    functions: sections.filter((s) => !s.isConstructor),
  };
}
