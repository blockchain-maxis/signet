/**
 * The phase-3 call graph overlay (#543, design §1.6): which of this
 * contract's functions called which other contracts, how often, and on what
 * evidence.
 *
 * Two sources feed it. Indexed transactions (#516) give, per stored
 * invocation, the function this contract was invoked with and the call edges
 * out of it; every edge out of an invocation of `f` was made inside `f`, so
 * `f` is the calling function. Local sandbox traces (#542) give the real call
 * tree. A call whose function nothing names starts from the contract itself.
 *
 * Counts are per transaction (or per sandbox run): a transaction that called
 * the same contract from the same function twice counts once. The overlay
 * also carries the window it was observed in, so the diagram can say what it
 * does not show.
 *
 * Pure: plain data in, plain data out.
 */

import type { ContractGraph } from '../graph.ts';
import type { CallEdge, CallEvidence } from './calls.ts';
import type { CallNode } from './sandbox.ts';

const EVIDENCE_RANK: Record<CallEvidence, number> = { footprint: 0, event: 1, 'auth-tree': 2 };

/** One stored invocation, as the call graph needs it. */
export interface CallGraphRow {
  readonly ledger: number;
  /** The function this contract was invoked with, when known. */
  readonly function: string | null;
  readonly callEdges: readonly CallEdge[] | null | undefined;
}

/** Calls from one function (or, `from: null`, from an unknown function) to one contract. */
export interface CallGraphEdge {
  /** The calling function; null when nothing names it. */
  readonly from: string | null;
  readonly to: string;
  /** Transactions that showed this call. */
  readonly transactions: number;
  /** The strongest chain evidence for it; null when only sandbox runs saw it. */
  readonly evidence: CallEvidence | null;
  /** Local sandbox runs that made this call. */
  readonly sandboxRuns: number;
}

export interface CallGraphOverlay {
  readonly contract: string;
  /** Heaviest first; ties by callee, then by calling function. */
  readonly edges: readonly CallGraphEdge[];
  /** Stored invocations examined, and the ledgers they span. */
  readonly transactions: number;
  readonly firstLedger: number | null;
  readonly lastLedger: number | null;
  /** Sandbox runs examined. */
  readonly sandboxRuns: number;
}

interface Building {
  from: string | null;
  to: string;
  transactions: number;
  evidence: CallEvidence | null;
  sandboxRuns: number;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The call graph out of `contract` over stored invocations and sandbox runs. */
export function buildCallGraph(
  contract: string,
  rows: readonly CallGraphRow[],
  sandboxRuns: readonly (readonly CallNode[])[] = [],
): CallGraphOverlay {
  const edges = new Map<string, Building>();
  const edge = (from: string | null, to: string): Building => {
    const key = `${from ?? ''}\u0000${to}`;
    let found = edges.get(key);
    if (!found) {
      found = { from, to, transactions: 0, evidence: null, sandboxRuns: 0 };
      edges.set(key, found);
    }
    return found;
  };

  let firstLedger: number | null = null;
  let lastLedger: number | null = null;
  for (const row of rows) {
    firstLedger = firstLedger === null ? row.ledger : Math.min(firstLedger, row.ledger);
    lastLedger = lastLedger === null ? row.ledger : Math.max(lastLedger, row.ledger);
    const seen = new Set<Building>();
    for (const call of row.callEdges ?? []) {
      if (call.from !== contract || call.to === contract) continue;
      const e = edge(row.function, call.to);
      if (!seen.has(e)) {
        seen.add(e);
        e.transactions++;
      }
      if (e.evidence === null || EVIDENCE_RANK[call.evidence] > EVIDENCE_RANK[e.evidence]) {
        e.evidence = call.evidence;
      }
    }
  }

  for (const run of sandboxRuns) {
    const seen = new Set<Building>();
    const visit = (node: CallNode) => {
      for (const child of node.children) {
        if (node.contract === contract && child.contract !== contract) {
          const e = edge(node.function, child.contract);
          if (!seen.has(e)) {
            seen.add(e);
            e.sandboxRuns++;
          }
        }
        visit(child);
      }
    };
    run.forEach(visit);
  }

  const weight = (e: Building) => e.transactions + e.sandboxRuns;
  return {
    contract,
    edges: [...edges.values()].sort(
      (a, b) => weight(b) - weight(a) || compare(a.to, b.to) || compare(a.from ?? '', b.from ?? ''),
    ),
    transactions: rows.length,
    firstLedger,
    lastLedger,
    sandboxRuns: sandboxRuns.length,
  };
}

/**
 * The provenance line the diagram prints under a call graph: "Calls observed
 * in 12 transactions (ledgers 100–250) and 2 local sandbox runs. Calls that
 * never happened in that window aren’t shown."
 */
export function describeCallWindow(
  overlay: Pick<CallGraphOverlay, 'transactions' | 'firstLedger' | 'lastLedger' | 'sandboxRuns'>,
): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const span =
    overlay.firstLedger === null
      ? ''
      : overlay.firstLedger === overlay.lastLedger
        ? ` (ledger ${overlay.firstLedger})`
        : ` (ledgers ${overlay.firstLedger}–${overlay.lastLedger})`;
  return (
    `Calls observed in ${plural(overlay.transactions, 'transaction', 'transactions')}${span}` +
    ` and ${plural(overlay.sandboxRuns, 'local sandbox run', 'local sandbox runs')}.` +
    ' Calls that never happened in that window aren’t shown.'
  );
}

/**
 * The spec graph cut down to the functions that made calls, with no types:
 * what the diagram draws when the interface itself is too simple or too
 * large to draw but the call graph still has something to say (#543).
 */
export function callersOnly(graph: ContractGraph, overlay: CallGraphOverlay): ContractGraph {
  const callers = new Set(overlay.edges.map((e) => e.from).filter((f): f is string => f !== null));
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n.kind === 'function' && callers.has(n.name)),
    edges: [],
  };
}
