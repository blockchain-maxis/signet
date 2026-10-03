/**
 * @file Per-function permalink page data (#475).
 *
 * One view of the data `/p/{handle}/contract/{address}/functions` already
 * lists, at `/…/functions/{name}`. The permalink exists for the question
 * "how do I call X on this contract", so its own rules are narrow:
 *
 * - **The 404 rules are the shell's.** A contract this handle did not deploy
 *   is a 404, and so is a function name the interface does not export. Both
 *   are handled by the same `attributeContract` verdict the layout uses, never
 *   a second opinion.
 * - **A signature is documentation.** §2.4: an undocumented function renders
 *   in full with no prose. Absent prose must read as absent, so nothing here
 *   writes a sentence, infers one from the function name, or borrows one from
 *   a similar contract.
 * - **Every fact is derived from the deployed WASM.** The description falls
 *   back to the signature rather than to anything authored here.
 *
 * Everything in this module is pure so it can be tested with `node:test`
 * against literal `SpecFunction` values. The page's one side effect, reading
 * an interface, lives behind `FunctionSourceResult` and is injected.
 *
 * Two seams belong to other issues and are left narrow on purpose:
 *
 * - `formatTypeRef` is #465's. This module renders types for its own
 *   signature line and does not export the renderer, so #465 can own one
 *   canonical formatter without this page becoming a second source of truth.
 * - The `fn-` anchor is #473's convention. `FUNCTION_ANCHOR_PREFIX` pins the
 *   literal this page links to, and #473's `lib/docs/anchors.ts` becomes the
 *   owner when it lands.
 */

import type {
  SpecErrorCase,
  SpecField,
  SpecFunction,
  SpecType,
  TypeRef,
} from '@signet/spec';
import { contractTabSegmentHref } from '../contract-tabs.ts';

/** Child segment of the tab the permalink hangs under. */
const FUNCTIONS_SEGMENT = 'functions';

/**
 * Heading-id prefix for a function on the Functions tab. #473 owns the
 * canonical helper (`lib/docs/anchors.ts`); this page links to the convention
 * #473 documents rather than re-deriving it, so the two cannot disagree about
 * what a shared URL points at.
 */
export const FUNCTION_ANCHOR_PREFIX = 'fn-';

/** Heading id for a function on the Functions tab. */
export function functionAnchor(name: string): string {
  return `${FUNCTION_ANCHOR_PREFIX}${name}`;
}

/** The Functions tab for one contract, without a fragment. */
export function functionsTabHref(handle: string, address: string): string {
  return contractTabSegmentHref(handle, address, FUNCTIONS_SEGMENT);
}

/** Permalink for one function. */
export function functionPermalinkHref(handle: string, address: string, name: string): string {
  return `${functionsTabHref(handle, address)}/${name}`;
}

/**
 * Link from a permalink back to the function's section on the Functions tab.
 * The permalink is a view of the same data, so a reader who wants the
 * surrounding context gets the list and the fragment, not a dead end.
 */
export function functionBacklinkHref(handle: string, address: string, name: string): string {
  return `${functionsTabHref(handle, address)}#${functionAnchor(name)}`;
}

/**
 * Primitive label as it appears in a signature. The Rust SDK's own casing for
 * the wrapper types, so `claim(handle: String, wallet: Address)` reads the way
 * the contract's source does. The fixed-width integer family keeps its literal
 * name: `u32` is not a wrapper around a number, it is the number's width. The
 * unit type is `()`, as Rust writes it, which is what the design's canonical
 * `Result<(), Error>` shows.
 *
 * #465 owns `formatTypeRef`. This table is the page's own rendering; #465
 * replaces it with the shared formatter.
 */
const PRIMITIVE_LABELS: Readonly<Record<string, string | undefined>> = {
  val: 'Val',
  void: '()',
  bool: 'Bool',
  string: 'String',
  symbol: 'Symbol',
  address: 'Address',
  timepoint: 'Timepoint',
  duration: 'Duration',
  error: 'Error',
  bytes: 'Bytes',
  i32: 'i32',
  u32: 'u32',
  i64: 'i64',
  u64: 'u64',
  i128: 'i128',
  u128: 'u128',
  i256: 'i256',
  u256: 'u256',
};

/**
 * A type as it appears in a signature, e.g. `Option<Vec<Pool>>`.
 *
 * Exported because the page inlines one level of each referenced type, whose
 * fields carry types too. #465 owns `formatTypeRef`; this is that renderer's
 * first appearance, and it moves to the shared one when #465 lands.
 */
export function renderTypeRef(ref: TypeRef): string {
  // A primitive is the bare string itself, not an object with a `type` field,
  // so the union has to be split before the switch.
  if (typeof ref === 'string') return PRIMITIVE_LABELS[ref] ?? 'unknown';
  switch (ref.type) {
    case 'bytes_n':
      return `BytesN<${ref.n}>`;
    case 'option':
      return `Option<${renderTypeRef(ref.value)}>`;
    case 'result':
      return `Result<${renderTypeRef(ref.ok)}, ${renderTypeRef(ref.error)}>`;
    case 'vec':
      return `Vec<${renderTypeRef(ref.element)}>`;
    case 'map':
      return `Map<${renderTypeRef(ref.key)}, ${renderTypeRef(ref.value)}>`;
    case 'tuple':
      return ref.elements.length === 0
        ? '()'
        : `(${ref.elements.map(renderTypeRef).join(', ')})`;
    case 'named':
      return ref.name;
    default:
      // The `unknown` fallback, and any arm the pinned SDK adds after this was
      // written. A type this build cannot name renders as `unknown` rather
      // than as a guess, which is the honest answer.
      return 'unknown';
  }
}

function renderReturn(fn: SpecFunction): string {
  if (fn.outputs.length === 0) return '()';
  if (fn.outputs.length === 1) return renderTypeRef(fn.outputs[0]!);
  return `(${fn.outputs.map(renderTypeRef).join(', ')})`;
}

/** One argument, with its type already rendered for display. */
export interface FunctionArgument {
  readonly name: string;
  readonly type: string;
  readonly doc?: string;
}

function toArgument(field: SpecField): FunctionArgument {
  return { name: field.name, type: renderTypeRef(field.type), doc: field.doc };
}

/** A function's arguments in declaration order. */
export function functionArguments(fn: SpecFunction): readonly FunctionArgument[] {
  return fn.inputs.map(toArgument);
}

/** A function's return type, parenthesised when the spec returns several. */
export function functionReturnType(fn: SpecFunction): string {
  return renderReturn(fn);
}

/**
 * The full signature line, e.g. `claim(handle: String, wallet: Address) ->
 * Result<(), Error>`. This is the page's fallback description and the text
 * that carries the whole function when the contract documents nothing.
 */
export function functionSignature(fn: SpecFunction): string {
  const args = fn.inputs.map((input) => `${input.name}: ${renderTypeRef(input.type)}`);
  return `${fn.name}(${args.join(', ')}) -> ${renderReturn(fn)}`;
}

function typeMentionsError(ref: TypeRef): boolean {
  if (typeof ref === 'string') return ref === 'error';
  switch (ref.type) {
    case 'option':
      return typeMentionsError(ref.value);
    case 'result':
      return typeMentionsError(ref.ok) || typeMentionsError(ref.error);
    case 'vec':
      return typeMentionsError(ref.element);
    case 'map':
      return typeMentionsError(ref.key) || typeMentionsError(ref.value);
    case 'tuple':
      return ref.elements.some((element) => typeMentionsError(element));
    default:
      return false;
  }
}

/**
 * Whether the function's return type carries an `error`, which is the only
 * signal the interface gives about failure. It does not say which errors, see
 * `ERROR_SCOPE_NOTE`.
 */
export function functionReturnsError(fn: SpecFunction): boolean {
  return fn.outputs.some(typeMentionsError);
}

function collectNamedTypes(ref: TypeRef, into: Set<string>): void {
  if (typeof ref === 'string') return;
  switch (ref.type) {
    case 'named':
      into.add(ref.name);
      return;
    case 'option':
      collectNamedTypes(ref.value, into);
      return;
    case 'result':
      collectNamedTypes(ref.ok, into);
      collectNamedTypes(ref.error, into);
      return;
    case 'vec':
      collectNamedTypes(ref.element, into);
      return;
    case 'map':
      collectNamedTypes(ref.key, into);
      collectNamedTypes(ref.value, into);
      return;
    case 'tuple':
      for (const element of ref.elements) collectNamedTypes(element, into);
      return;
    default:
      return;
  }
}

/**
 * The user-defined types a function's signature names, unwrapped through
 * `Option`, `Vec`, `Map`, `Result` and tuples, in the order the spec declares
 * them. A reader following an argument type has to land somewhere (design
 * §2.3), which is why the permalink inlines one level of each of these rather
 * than sending them to the Types tab alone.
 *
 * A `named` reference with no matching type in the spec is dropped rather than
 * rendered: a dangling name is the contract's, and a link to nothing is worse
 * than no link.
 */
export function functionReferencedTypes(
  fn: SpecFunction,
  types: readonly SpecType[],
): readonly SpecType[] {
  const names = new Set<string>();
  for (const input of fn.inputs) collectNamedTypes(input.type, names);
  for (const output of fn.outputs) collectNamedTypes(output, names);
  return types.filter((type) => names.has(type.name));
}

/**
 * The contract's error cases, but only when the function's return type carries
 * an `error`. A function that cannot fail gets no error list rather than a
 * list of errors it has no path to.
 */
export function functionErrorCases(
  fn: SpecFunction,
  errors: readonly SpecErrorCase[],
): readonly SpecErrorCase[] {
  return functionReturnsError(fn) ? errors : [];
}

/**
 * What the error list is allowed to claim. The interface records the errors a
 * contract *defines*; it does not record which of them any one function
 * returns. Saying so is the difference between a reference and a guess.
 */
export const ERROR_SCOPE_NOTE =
  'The interface records which errors this contract defines, not which ones this function returns.';

/**
 * The first paragraph of a doc comment, or `undefined` when there is none.
 * #430 fixes absent docs to `''` rather than `undefined`, so both are treated
 * as absent. A doc comment's remaining paragraphs are #474's markdown, not
 * this page's business: the description is a single line, so a heading or a
 * list further down must not leak into a search result.
 */
export function firstDocParagraph(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  const paragraph = doc.trim().split(/\n\s*\n/)[0]?.trim() ?? '';
  if (!paragraph) return undefined;
  return paragraph.replace(/\s+/g, ' ');
}

/**
 * The page description. A contract's own first paragraph when it has one, and
 * the signature when it does not. Never anything written here: an invented
 * sentence would be wrong for some contract, and a generated description
 * cannot be checked against the WASM.
 */
export function functionPermalinkDescription(fn: SpecFunction): string {
  return firstDocParagraph(fn.doc) ?? functionSignature(fn);
}

/**
 * Address as it appears in the page title. The same shape as the shell's
 * identity strip, so the title and the strip above it abbreviate one contract
 * the same way.
 */
export function shortAddress(address: string): string {
  if (address.length <= 17) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

/** Page title: `{name} · {address short} · {handle}`. */
export function functionPermalinkTitle(args: {
  name: string;
  address: string;
  handle: string;
}): string {
  return `${args.name} · ${shortAddress(args.address)} · ${args.handle}`;
}

/**
 * The one function with this name, or `undefined`. Exact match: the interface
 * exports case-sensitive identifiers and `Claim` is not `claim`, so a
 * case-insensitive lookup would invent a function that does not exist.
 */
export function findFunction(
  functions: readonly SpecFunction[],
  name: string,
): SpecFunction | undefined {
  return functions.find((fn) => fn.name === name);
}

/**
 * Why an interface could not be read. Provisional: #464 replaces this with the
 * typed failure kinds the shared spec reader reports, and the page's rendering
 * branches on the replacement.
 */
export type FunctionSourceReason = 'spec_reader_unavailable';

/** The injected result of reading one contract's interface. Never throws. */
export type FunctionSourceResult =
  | { readonly ok: true; readonly spec: ContractSpecLike }
  | { readonly ok: false; readonly reason: FunctionSourceReason };

/**
 * The slice of a decoded spec this page reads. Structural rather than the
 * `ContractSpec` interface so a test can hand the page a literal, and so
 * #430's flattened views reach it without this page re-deriving them.
 */
export interface ContractSpecLike {
  readonly functions: readonly SpecFunction[];
  readonly types: readonly SpecType[];
  readonly errors: readonly SpecErrorCase[];
}

/** Everything the page renders, decided from the source and the URL segment. */
export type FunctionPageState =
  | {
      readonly kind: 'function';
      readonly fn: SpecFunction;
      readonly referencedTypes: readonly SpecType[];
      readonly errors: readonly SpecErrorCase[];
    }
  | { readonly kind: 'unknown-function' }
  | { readonly kind: 'interface-unavailable'; readonly reason: FunctionSourceReason };

/**
 * The page's only branch point, as a pure function of the source and the
 * requested name.
 *
 * An unreadable interface and an unknown function are different answers. The
 * first says nothing about the URL, so it renders the honest message rather
 * than a 404 that would blame a URL which is probably right. The second is a
 * real 404: the interface was read, and it does not export that name.
 */
export function resolveFunctionPage(
  source: FunctionSourceResult,
  name: string,
): FunctionPageState {
  if (!source.ok) return { kind: 'interface-unavailable', reason: source.reason };
  const fn = findFunction(source.spec.functions, name);
  if (!fn) return { kind: 'unknown-function' };
  return {
    kind: 'function',
    fn,
    referencedTypes: functionReferencedTypes(fn, source.spec.types),
    errors: functionErrorCases(fn, source.spec.errors),
  };
}
