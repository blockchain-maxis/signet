/**
 * @file apps/web/lib/contract-overview.ts
 *
 * Pure data and copy for the Overview tab (#449, docs/CONTRACT_DOCS_DESIGN.md
 * §1.5 and §2.2).
 *
 * The provenance rule is the whole design: every fact on the Overview comes
 * from the deployed WASM or the index, nothing is inferred and nothing is
 * written by Signet. So this module only counts, formats and picks between a
 * fixed set of sentences. It never composes prose about what a contract does,
 * and it has no placeholder for a missing description: an absent fact is
 * absent, not replaced by a sentence.
 *
 * Everything here is pure so the counts and the copy are testable against a
 * fixture spec without a network or a database.
 */

import { xdr } from '@stellar/stellar-sdk';
import { buildSpecViews, type SpecJson } from '@signet/spec';

/**
 * Fill a `SpecJson`'s flattened views from its `entriesXdr` when they are
 * empty but entries exist.
 *
 * The RPC reader's `decodeWasm` still returns empty `functions`, `types` and
 * `errors` (the TODO(#424) stopgap in `@signet/spec/fetch`), so a spec fresh
 * off the network would otherwise read as "0 functions". That would present a
 * decoding gap as a fact about the contract. `entriesXdr` is the source of
 * truth, so the views are rebuilt from it; a spec whose views are already
 * populated is returned untouched. `build` stays absent until #432, so the
 * build line is simply omitted, never guessed.
 */
export function withFlattenedViews(json: SpecJson): SpecJson {
  const empty = json.functions.length === 0 && json.types.length === 0 && json.errors.length === 0;
  if (!empty || json.entriesXdr.length === 0) return json;
  const entries = json.entriesXdr.map((entry) => xdr.ScSpecEntry.fromXDR(entry, 'base64'));
  return { ...json, ...buildSpecViews(entries) };
}

/** The slice of a decoded spec the overview reads; `SpecJson` satisfies it. */
export interface OverviewSpec {
  readonly functions: readonly { readonly doc?: string }[];
  readonly types: readonly unknown[];
  readonly errors: readonly unknown[];
  readonly build?: {
    readonly rustVersion?: string;
    readonly sdkVersion?: string;
  };
}

/**
 * Why a spec could not be shown (§1.5). The first three are the design's
 * failure modes; `unavailable` is the fourth honest state the design does not
 * list: the RPC (or the index) could not be reached, so nothing is known about
 * the contract's interface either way. `wrong_network` is the loader's own
 * guard (#464): the contract is on a network this deployment does not read, so
 * no RPC is queried and nothing is known about it from here.
 */
export type SpecFailure =
  | { readonly kind: 'contract_not_found'; readonly network: string }
  | { readonly kind: 'no_interface' }
  | { readonly kind: 'interface_unreadable'; readonly sdkVersion: string }
  | { readonly kind: 'unavailable' }
  | {
      readonly kind: 'wrong_network';
      /** The network the contract is on. */
      readonly network: string;
      /** The network this deployment reads. */
      readonly expectedNetwork: string;
    };

/** What `summariseSpec` takes: a decoded spec, or the reason there is none. */
export type SpecInput =
  | { readonly kind: 'spec'; readonly spec: OverviewSpec }
  | { readonly kind: 'failure'; readonly failure: SpecFailure };

/** The interface summary: three counts and the doc-comment coverage line. */
export interface InterfaceSummary {
  readonly functionCount: number;
  readonly typeCount: number;
  readonly errorCount: number;
  readonly documentedFunctions: number;
  /** Count label with its noun, e.g. `8 functions`. */
  readonly functionsLabel: string;
  readonly typesLabel: string;
  readonly errorsLabel: string;
  /** e.g. `5 of 8 functions documented`; `null` when the contract has no functions. */
  readonly coverage: string | null;
}

/** A failure rendered as its two lines of copy. */
export interface FailureCopy {
  readonly kind: SpecFailure['kind'];
  /** The headline, the §1.5 wording verbatim. */
  readonly title: string;
  /** One factual sentence, or `null` when the headline says everything. */
  readonly detail: string | null;
}

export type OverviewSummary =
  | {
      readonly status: 'ok';
      readonly interface: InterfaceSummary;
      /** Build provenance line from `contractmetav0`, or `null` when absent. */
      readonly build: string | null;
    }
  | { readonly status: 'failure'; readonly failure: FailureCopy; readonly build: null };

/** `1 function`, `8 functions`. */
function counted(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** True when a doc comment carries text; `''` and whitespace-only are absent. */
function hasDoc(doc: string | undefined): boolean {
  return typeof doc === 'string' && doc.trim().length > 0;
}

/**
 * Build provenance from `contractmetav0`: the Rust and SDK versions the WASM
 * was built with, as the contract states them. `null` when neither is present,
 * so the line is omitted rather than written as "unknown". #471 replaces this
 * line with the full provenance strip.
 */
export function buildProvenanceLine(build: OverviewSpec['build']): string | null {
  const parts: string[] = [];
  if (build?.rustVersion) parts.push(`Rust ${build.rustVersion}`);
  if (build?.sdkVersion) parts.push(`soroban-sdk ${build.sdkVersion}`);
  return parts.length > 0 ? `Built with ${parts.join(' and ')}` : null;
}

/**
 * The §1.5 copy for each failure. The headlines are the design's own words;
 * the detail adds only a fact the failure itself carries (the network, the SDK
 * version) and never a guess about the cause.
 */
export function failureCopy(failure: SpecFailure): FailureCopy {
  switch (failure.kind) {
    case 'contract_not_found':
      return {
        kind: failure.kind,
        title: `Not found on ${failure.network}`,
        detail: `No contract with this address exists on ${failure.network}. Check that the network is the one it was deployed to.`,
      };
    case 'no_interface':
      // A statement about the contract, not an error (§1.5).
      return {
        kind: failure.kind,
        title: 'This contract publishes no interface',
        detail: null,
      };
    case 'interface_unreadable':
      return {
        kind: failure.kind,
        title: 'Interface could not be read',
        detail: `Decoding failed with @stellar/stellar-sdk ${failure.sdkVersion}.`,
      };
    case 'wrong_network':
      return {
        kind: failure.kind,
        title: `This contract is on ${failure.network}`,
        detail: `This site reads ${failure.expectedNetwork}, so the interface of a ${failure.network} contract cannot be shown here.`,
      };
    case 'unavailable':
      return {
        kind: failure.kind,
        title: 'Interface is unavailable right now',
        detail:
          'The Soroban RPC could not be reached, so nothing is known about this contract’s interface. Try again shortly.',
      };
  }
}

/**
 * Summarise a contract's interface for the Overview tab.
 *
 * Counts are of what the spec holds: functions, user-defined types, and error
 * cases. Doc-comment coverage counts functions with a non-blank doc comment.
 * A failure yields its own copy and no counts: zeros would read as "the
 * contract has an empty interface", which is a different claim.
 */
export function summariseSpec(input: SpecInput): OverviewSummary {
  if (input.kind === 'failure') {
    return { status: 'failure', failure: failureCopy(input.failure), build: null };
  }

  const { spec } = input;
  const functionCount = spec.functions.length;
  const documentedFunctions = spec.functions.filter((fn) => hasDoc(fn.doc)).length;

  return {
    status: 'ok',
    interface: {
      functionCount,
      typeCount: spec.types.length,
      errorCount: spec.errors.length,
      documentedFunctions,
      functionsLabel: counted(functionCount, 'function', 'functions'),
      typesLabel: counted(spec.types.length, 'type', 'types'),
      errorsLabel: counted(spec.errors.length, 'error case', 'error cases'),
      coverage:
        functionCount === 0
          ? null
          : `${documentedFunctions} of ${functionCount} ${functionCount === 1 ? 'function' : 'functions'} documented`,
    },
    build: buildProvenanceLine(spec.build),
  };
}

/**
 * Map an error thrown by the spec resolver to a `SpecFailure`. Matches on the
 * typed `kind` rather than `instanceof` so it holds across module copies.
 * Anything it does not recognise is `unavailable`: an unexpected failure says
 * nothing about the contract, and must not read as "no interface".
 */
export function classifySpecError(error: unknown, network: string): SpecFailure {
  const e = error as { kind?: unknown; sdkVersion?: unknown } | null;
  switch (e?.kind) {
    case 'contract_not_found':
      return { kind: 'contract_not_found', network };
    case 'no_interface':
      return { kind: 'no_interface' };
    case 'interface_unreadable':
      return {
        kind: 'interface_unreadable',
        sdkVersion: typeof e.sdkVersion === 'string' ? e.sdkVersion : 'unknown',
      };
    default:
      return { kind: 'unavailable' };
  }
}

/** An indexed activity snapshot, as the Overview needs it. */
export interface ActivitySnapshotInput {
  readonly txCount24h: number;
  readonly txCountTotal: number;
  readonly totalIsFloor?: boolean;
  /**
   * When counting began. `null` or absent marks a snapshot written before
   * #429: Horizon rejects `forAccount(C...)`, so every such snapshot is a zero
   * that means "not measured", never "no usage" (#452).
   */
  readonly countedSince?: Date | null;
  readonly lastActivity?: Date | null;
  readonly capturedAt: Date;
}

export type ActivitySummary =
  | { readonly measured: false; readonly message: string }
  | {
      readonly measured: true;
      readonly last24h: string;
      /** `{n}` or `{n}+` when the total is a floor. */
      readonly total: string;
      /** Always stated with the total: `since 2026-03-01`. */
      readonly since: string;
      readonly lastActivity: string | null;
    };

/** Shown when there is no trustworthy snapshot. Says "not measured", never "none". */
export const ACTIVITY_NOT_MEASURED =
  'Activity has not been measured for this contract yet, so no count is shown.';

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Summarise the newest snapshot. A missing snapshot and a snapshot without
 * `countedSince` are the same thing, "not measured". A floor total renders as
 * `{n}+`, and the total is always paired with the date counting began.
 */
export function summariseActivity(snapshot: ActivitySnapshotInput | null): ActivitySummary {
  if (!snapshot || !snapshot.countedSince) {
    return { measured: false, message: ACTIVITY_NOT_MEASURED };
  }
  return {
    measured: true,
    last24h: String(snapshot.txCount24h),
    total: snapshot.totalIsFloor ? `${snapshot.txCountTotal}+` : String(snapshot.txCountTotal),
    since: `since ${isoDay(snapshot.countedSince)}`,
    lastActivity: snapshot.lastActivity ? isoDay(snapshot.lastActivity) : null,
  };
}
