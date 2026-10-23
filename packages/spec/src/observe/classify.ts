/**
 * @file packages/spec/src/observe/classify.ts
 *
 * The phase-2 mutability mark (#510): observations in, one mark per spec
 * function out, each stating exactly how strong its evidence is.
 *
 * The spec carries no mutability annotation (CONTRACT_VISUALISER_DESIGN.md
 * §1.2), and an unlabelled guess is the one thing that breaks the "derived
 * from the deployed code, cannot be wrong" property. So the classifier never
 * outputs a bare "read-only": a function either has write evidence
 * (`writes`, with how strong it is and an example), was observed without any
 * (`no-writes-seen`, with how often and when — absence of evidence is not
 * evidence of absence), or was never observed (`unknown`). The
 * name/return-type heuristic (`get_*`, `-> Option`) is deliberately not
 * implemented.
 *
 * Rules:
 * - Only observations of the spec's own `wasmHash` count. Observations of an
 *   earlier version are counted as `staleObservations`; ones recorded with no
 *   hash cannot be attributed to a version and are counted as
 *   `unversionedObservations`. Neither is evidence.
 * - Write evidence is an `own-data` / `own-instance` key. With meta, only
 *   `changed` counts (`evidence: 'changed'`): meta cannot claim a change
 *   that did not happen, and a declared write it does not confirm was never
 *   made. Without meta, `readWrite` counts as `evidence: 'declared'`.
 * - A failed transaction rolled back, so it counts as declared at most,
 *   never changed.
 * - Seeded sandbox runs (`sandboxRun.seeded`) are kept but flagged: they
 *   decide the mark only when nothing else observed the function, and the
 *   mark then says so (`seededOnly`).
 *
 * Pure: plain data in, plain data out.
 */

import type { ContractSpec } from '../types.ts';
import { isOwnStateWrite } from './normalise.ts';
import type { FootprintObservation, LedgerKeyRef, ObservationSource } from './types.ts';

/** How a write is known: confirmed by transaction meta, or only declared in a footprint. */
export type WriteEvidence = 'changed' | 'declared';

/** The observation a `writes` mark cites. */
export interface ObservationExample {
  readonly source: ObservationSource;
  readonly ledger: number;
  /** For `source: 'transaction'`. */
  readonly txHash?: string;
  /** For `source: 'sandbox'`. */
  readonly sandboxRun?: { readonly seeded: boolean; readonly wasmHash: string };
}

/** Counts every mark carries, so the UI can say what was set aside. */
interface MarkCounts {
  /** Observations of an earlier code version, ignored. */
  readonly staleObservations: number;
  /** Observations with no recorded code version, ignored. */
  readonly unversionedObservations: number;
  /** Counted observations that came from seeded sandbox runs. */
  readonly seededObservations: number;
}

export interface WritesMark extends MarkCounts {
  readonly kind: 'writes';
  /** The strongest evidence any deciding observation gave. */
  readonly evidence: WriteEvidence;
  /** The most recent deciding observation with that evidence. */
  readonly example: ObservationExample;
  /** Deciding observations with write evidence. */
  readonly writingObservations: number;
  /** All deciding observations. */
  readonly observations: number;
  /** True when only seeded sandbox runs decided this mark. */
  readonly seededOnly: boolean;
}

export interface NoWritesSeenMark extends MarkCounts {
  readonly kind: 'no-writes-seen';
  /** Deciding observations, none with write evidence. Always ≥ 1. */
  readonly observations: number;
  readonly firstLedger: number;
  readonly lastLedger: number;
  /** True when only seeded sandbox runs decided this mark. */
  readonly seededOnly: boolean;
}

export interface UnknownMark extends MarkCounts {
  readonly kind: 'unknown';
}

export type MutabilityMark = WritesMark | NoWritesSeenMark | UnknownMark;

const hasOwnWrite = (refs: readonly LedgerKeyRef[] | undefined): boolean => !!refs?.some(isOwnStateWrite);

/** The write evidence one observation gives, if any. */
export function writeEvidence(observation: FootprintObservation): WriteEvidence | null {
  if (!observation.successful) return hasOwnWrite(observation.readWrite) ? 'declared' : null;
  if (observation.changed !== undefined) return hasOwnWrite(observation.changed) ? 'changed' : null;
  return hasOwnWrite(observation.readWrite) ? 'declared' : null;
}

function exampleOf(observation: FootprintObservation): ObservationExample {
  return {
    source: observation.source,
    ledger: observation.ledger,
    ...(observation.txHash !== undefined && { txHash: observation.txHash }),
    ...(observation.sandboxRun !== undefined && { sandboxRun: observation.sandboxRun }),
  };
}

function markFrom(deciding: readonly FootprintObservation[], counts: MarkCounts, seededOnly: boolean): MutabilityMark {
  if (deciding.length === 0) return { kind: 'unknown', ...counts };

  let strongest: WriteEvidence | null = null;
  let example: FootprintObservation | null = null;
  let writingObservations = 0;
  let firstLedger = Infinity;
  let lastLedger = -Infinity;
  for (const obs of deciding) {
    firstLedger = Math.min(firstLedger, obs.ledger);
    lastLedger = Math.max(lastLedger, obs.ledger);
    const evidence = writeEvidence(obs);
    if (!evidence) continue;
    writingObservations++;
    const stronger = strongest !== 'changed' && evidence === 'changed';
    if (strongest === null || stronger || (evidence === strongest && obs.ledger > example!.ledger)) {
      strongest = evidence;
      example = obs;
    }
  }

  if (strongest && example) {
    return {
      kind: 'writes',
      evidence: strongest,
      example: exampleOf(example),
      writingObservations,
      observations: deciding.length,
      seededOnly,
      ...counts,
    };
  }
  return { kind: 'no-writes-seen', observations: deciding.length, firstLedger, lastLedger, seededOnly, ...counts };
}

const isSeeded = (obs: FootprintObservation): boolean => obs.source === 'sandbox' && obs.sandboxRun?.seeded === true;

/**
 * One mark per spec function, from the observations of the contract that
 * spec describes. Observations naming no function, or one the spec does not
 * export, are ignored.
 */
export function classifyFunctions(
  spec: Pick<ContractSpec, 'wasmHash' | 'functions'>,
  observations: readonly FootprintObservation[],
): Map<string, MutabilityMark> {
  const byFunction = new Map<string, FootprintObservation[]>();
  for (const fn of spec.functions) byFunction.set(fn.name, []);
  for (const obs of observations) {
    if (obs.function !== null) byFunction.get(obs.function)?.push(obs);
  }

  const marks = new Map<string, MutabilityMark>();
  for (const [name, seen] of byFunction) {
    let staleObservations = 0;
    let unversionedObservations = 0;
    const current: FootprintObservation[] = [];
    for (const obs of seen) {
      const hash = obs.wasmHash ?? obs.sandboxRun?.wasmHash ?? null;
      if (hash === null) unversionedObservations++;
      else if (hash !== spec.wasmHash) staleObservations++;
      else current.push(obs);
    }
    const seeded = current.filter(isSeeded);
    const unseeded = current.filter((obs) => !isSeeded(obs));
    const counts = { staleObservations, unversionedObservations, seededObservations: seeded.length };
    marks.set(name, unseeded.length ? markFrom(unseeded, counts, false) : markFrom(seeded, counts, seeded.length > 0));
  }
  return marks;
}

const calls = (n: number) => `${n} observed call${n === 1 ? '' : 's'}`;

/**
 * The mark in words, for a label or tooltip. Never "read-only": the most the
 * absence of write evidence can say is that none was seen.
 */
export function describeMark(mark: MutabilityMark): string {
  const seeded = 'seededOnly' in mark && mark.seededOnly ? ', seeded sandbox runs only' : '';
  switch (mark.kind) {
    case 'writes': {
      const how = mark.evidence === 'changed' ? 'confirmed by transaction meta' : 'declared in the footprint';
      return `wrote in ${mark.writingObservations} of ${calls(mark.observations)} (${how}${seeded})`;
    }
    case 'no-writes-seen': {
      const range = mark.firstLedger === mark.lastLedger ? `ledger ${mark.firstLedger}` : `ledgers ${mark.firstLedger}–${mark.lastLedger}`;
      return `no writes seen in ${calls(mark.observations)} (${range}${seeded})`;
    }
    case 'unknown':
      return 'not observed';
  }
}

/** "12 observations from a previous version ignored", or null when none were. */
export function describeIgnored(mark: MutabilityMark): string | null {
  const parts: string[] = [];
  const obs = (n: number) => `${n} observation${n === 1 ? '' : 's'}`;
  if (mark.staleObservations) parts.push(`${obs(mark.staleObservations)} from a previous version ignored`);
  if (mark.unversionedObservations) parts.push(`${obs(mark.unversionedObservations)} with no recorded version ignored`);
  return parts.length ? parts.join('; ') : null;
}
