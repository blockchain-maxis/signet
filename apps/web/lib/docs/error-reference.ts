/**
 * @file The Types tab's Errors section, as data (#468, design §2.3).
 *
 * "What a call can fail with is documentation, and it is the half most
 * hand-written contract docs omit." One table per error enum, in declaration
 * order, with each case's code, name and doc comment.
 *
 * The view model is pure so the row counts, the codes and the collision rule
 * are testable against the fixture specs with `node:test`, without a render.
 * `_docs/error-list.tsx` only lays this out.
 *
 * Collisions: a Soroban failure surfaces as `Error(Contract, #n)`, which names
 * a number and not the enum that raised it. When two enums of one contract
 * declare the same number, the code alone is ambiguous, so the note that says
 * so is shown only then. An enum never merges with another, even on a clash.
 */

import type { SpecErrorCase } from '@signet/spec';
import { errorAnchor } from './anchors.ts';

/** The slice of a decoded spec the section reads; `SpecJson` satisfies it. */
export interface ErrorReferenceSpec {
  readonly errors: readonly SpecErrorCase[];
}

export interface ErrorRow {
  /** Fragment id from the shared anchor helper (`error-{enum}-{name}`). */
  readonly id: string;
  readonly code: number;
  readonly name: string;
  /** The doc comment, or `''` when the contract has none. */
  readonly doc: string;
  /** Whether another enum of this contract uses the same code. */
  readonly collides: boolean;
}

export interface ErrorTable {
  readonly enumName: string;
  readonly rows: readonly ErrorRow[];
}

export interface ErrorReference {
  /** One table per error enum, in declaration order. Never empty. */
  readonly tables: readonly ErrorTable[];
  /** Codes declared by more than one enum, ascending. Empty when none clash. */
  readonly sharedCodes: readonly number[];
  /** How a failure reads on chain. Always shown with the section. */
  readonly onChainNote: string;
  /** Why the code alone is ambiguous; `null` unless `sharedCodes` is non-empty. */
  readonly sharedNote: string | null;
}

/** What a contract failure looks like on chain. It is a fact about Soroban. */
export const ON_CHAIN_NOTE =
  'On chain, a failure surfaces as Error(Contract, #n), where n is the code below.';

/** Shown only when two enums of the same contract declare the same code. */
export const SHARED_CODE_NOTE =
  'Some codes appear in more than one enum. Error(Contract, #n) carries only the number, so for those the code alone does not say which enum raised it.';

/**
 * The Errors section for a contract.
 *
 * @param spec - the contract's decoded interface.
 * @returns the tables and notes, or `null` when the contract defines no error
 *   enum, so the caller omits the section entirely.
 */
export function buildErrorReference(spec: ErrorReferenceSpec): ErrorReference | null {
  if (spec.errors.length === 0) return null;

  const order: string[] = [];
  const byEnum = new Map<string, SpecErrorCase[]>();
  // Enum names that use each code.
  const owners = new Map<number, Set<string>>();
  for (const c of spec.errors) {
    let cases = byEnum.get(c.enumName);
    if (!cases) {
      cases = [];
      byEnum.set(c.enumName, cases);
      order.push(c.enumName);
    }
    cases.push(c);
    let set = owners.get(c.value);
    if (!set) {
      set = new Set();
      owners.set(c.value, set);
    }
    set.add(c.enumName);
  }

  const sharedCodes = [...owners.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([code]) => code)
    .sort((a, b) => a - b);
  const shared = new Set(sharedCodes);

  const tables = order.map((enumName) => ({
    enumName,
    rows: (byEnum.get(enumName) ?? []).map((c) => ({
      id: errorAnchor(enumName, c.name),
      code: c.value,
      name: c.name,
      doc: c.doc,
      collides: shared.has(c.value),
    })),
  }));

  return {
    tables,
    sharedCodes,
    onChainNote: ON_CHAIN_NOTE,
    sharedNote: sharedCodes.length > 0 ? SHARED_CODE_NOTE : null,
  };
}
