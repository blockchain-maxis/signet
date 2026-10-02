/**
 * @file @signet/spec
 *
 * Referenced-type closure (§2.3 of docs/CONTRACT_DOCS_DESIGN.md): which
 * user-defined types a set of functions can reach through their signatures.
 * Docs and the visualiser both use this so they agree on what to draw.
 */

import type { ContractSpec, SpecType, TypeRef } from './types.ts';

/** Result of {@link referencedTypes}. */
export interface ReferencedTypes {
  /** UDT names reachable from the signatures, in discovery order. */
  readonly names: readonly string[];
  /** Referenced names that no type or error enum in the spec defines. */
  readonly missing: readonly string[];
}

/** Named types directly mentioned by a type reference. */
function collectNamed(ref: TypeRef, into: string[]): void {
  if (typeof ref === 'string') return;
  switch (ref.type) {
    case 'named':
      into.push(ref.name);
      return;
    case 'option':
      collectNamed(ref.value, into);
      return;
    case 'result':
      collectNamed(ref.ok, into);
      collectNamed(ref.error, into);
      return;
    case 'vec':
      collectNamed(ref.element, into);
      return;
    case 'map':
      collectNamed(ref.key, into);
      collectNamed(ref.value, into);
      return;
    case 'tuple':
      for (const el of ref.elements) collectNamed(el, into);
      return;
    default:
      return;
  }
}

/** Named types directly mentioned by a type definition's members. */
function directRefs(type: SpecType): string[] {
  const out: string[] = [];
  if (type.kind === 'struct') {
    for (const f of type.fields) collectNamed(f.type, out);
  } else if (type.kind === 'union') {
    for (const c of type.cases) for (const f of c.fields) collectNamed(f.type, out);
  }
  return out;
}

/**
 * The transitive set of UDT names reachable from the signatures of `fnNames`
 * (every function when omitted). Function names the spec does not define are
 * ignored.
 *
 * Tolerates cycles (each name is visited once) and dangling `named`
 * references, which are reported in `missing` rather than thrown. Error enums
 * are not `types`; a reference to one is neither reported as missing nor
 * included in `names`, because the errors view renders them.
 */
export function referencedTypes(
  spec: Pick<ContractSpec, 'functions' | 'types' | 'errors'>,
  fnNames?: readonly string[],
): ReferencedTypes {
  const wanted = fnNames === undefined ? undefined : new Set(fnNames);
  const byName = new Map<string, SpecType>();
  for (const t of spec.types) if (!byName.has(t.name)) byName.set(t.name, t);
  const errorEnums = new Set<string>();
  for (const e of spec.errors) errorEnums.add(e.enumName);

  const queue: string[] = [];
  for (const fn of spec.functions) {
    if (wanted !== undefined && !wanted.has(fn.name)) continue;
    for (const input of fn.inputs) collectNamed(input.type, queue);
    for (const output of fn.outputs) collectNamed(output, queue);
  }

  const seen = new Set<string>();
  const names: string[] = [];
  const missing: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i]!;
    if (seen.has(name)) continue;
    seen.add(name);
    const type = byName.get(name);
    if (type !== undefined) {
      names.push(name);
      queue.push(...directRefs(type));
    } else if (!errorEnums.has(name)) {
      missing.push(name);
    }
  }
  return { names, missing };
}
