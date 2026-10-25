/**
 * @file How one build's interface differs from another's, by diagram node
 * (#580): a set diff on node ids, and a changed signature for a node in
 * both. The local UI badges what a hot-swap added or changed and lists
 * what it removed, the spec changes that would break an upgrade.
 *
 * Pure: two specs in, three sorted lists out. Signatures are the spec
 * reader's own plain data, so the same declaration always compares equal.
 */

import type { ContractSpec } from '@signet/spec';

export interface InterfaceDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** Node id -> signature, for every function and type the diagram draws. */
export function interfaceSignatures(spec: Pick<ContractSpec, 'functions' | 'types'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const fn of spec.functions) {
    out.set(`fn:${fn.name}`, JSON.stringify({ inputs: fn.inputs.map((i) => [i.name, i.type]), outputs: fn.outputs }));
  }
  for (const type of spec.types) {
    const { doc: _doc, ...shape } = type as typeof type & { doc?: string };
    out.set(`type:${type.name}`, JSON.stringify(shape));
  }
  return out;
}

export function diffInterfaces(
  before: Pick<ContractSpec, 'functions' | 'types'>,
  after: Pick<ContractSpec, 'functions' | 'types'>,
): InterfaceDiff {
  const a = interfaceSignatures(before);
  const b = interfaceSignatures(after);
  const added: string[] = [];
  const changed: string[] = [];
  for (const [id, sig] of b) {
    if (!a.has(id)) added.push(id);
    else if (a.get(id) !== sig) changed.push(id);
  }
  const removed = [...a.keys()].filter((id) => !b.has(id));
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** The badges `renderDiagramSvg`'s `diff` option draws. */
export function diffBadges(diff: InterfaceDiff): Record<string, 'added' | 'changed'> {
  return Object.fromEntries([
    ...diff.added.map((id) => [id, 'added'] as const),
    ...diff.changed.map((id) => [id, 'changed'] as const),
  ]);
}
