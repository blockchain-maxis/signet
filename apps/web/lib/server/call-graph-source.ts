/**
 * @file apps/web/lib/server/call-graph-source.ts
 *
 * The contract diagram's call graph (#543): the stored invocations of one
 * contract (#417, their `callEdges` from #516) aggregated into an overlay, and
 * a plain-language label for each callee (#517).
 *
 * The window is the newest `CALL_GRAPH_WINDOW` stored invocations; the diagram
 * says so, and that calls outside it are not shown. Database-only, like the
 * Activity tab: without a database there is no call graph, and the diagram
 * draws the spec alone. A failure reads as no call graph, never as an error
 * on the page.
 */

import {
  buildCallGraph,
  type CallEdge,
  type CallGraphOverlay,
  type CallGraphRow,
} from '@signet/visualiser';
import { logger } from '../logger.ts';
import { labelCallees, type CalleeLabel, type CalleeLabelDeps } from './diagram.ts';

/** Stored invocations the call graph is drawn from, newest first. */
export const CALL_GRAPH_WINDOW = 1000;

export interface ContractCallGraph {
  readonly overlay: CallGraphOverlay;
  readonly labels: ReadonlyMap<string, CalleeLabel>;
}

export interface CallGraphDeps {
  listRows?: (
    address: string,
    network: string,
    limit: number,
  ) => Promise<readonly CallGraphRow[] | undefined>;
  labels?: CalleeLabelDeps;
}

async function defaultRows(
  address: string,
  network: string,
  limit: number,
): Promise<readonly CallGraphRow[] | undefined> {
  if (!process.env.DATABASE_URL) return undefined;
  const { prisma } = await import('@signet/db');
  const rows = await prisma.contractInvocation.findMany({
    where: { contract: { address, network } },
    orderBy: [{ ledger: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { ledger: true, function: true, callEdges: true },
  });
  return rows.map((r) => ({
    ledger: r.ledger,
    function: r.function,
    callEdges: Array.isArray(r.callEdges) ? (r.callEdges as unknown as CallEdge[]) : null,
  }));
}

/** The call graph out of `address`, or null when there is none to draw. */
export async function loadContractCallGraph(
  address: string,
  network: string,
  deps: CallGraphDeps = {},
): Promise<ContractCallGraph | null> {
  try {
    const rows = await (deps.listRows ?? defaultRows)(address, network, CALL_GRAPH_WINDOW);
    if (!rows || rows.length === 0) return null;
    const overlay = buildCallGraph(address, rows);
    if (overlay.edges.length === 0) return null;
    const labels = await labelCallees(
      overlay.edges.map((e) => e.to),
      network,
      deps.labels,
    );
    return { overlay, labels };
  } catch (error) {
    logger.warn({ address, network, error }, 'call graph unavailable');
    return null;
  }
}
