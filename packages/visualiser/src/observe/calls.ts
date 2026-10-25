/**
 * Cross-contract call edges observed in real transactions (#516, design §1.4).
 *
 * Call edges are not in the spec, and on-chain the evidence is partial, so
 * every edge records how it is known. A stored transaction offers three
 * sources, strongest first:
 *
 * - `auth-tree` — the auth entries' `rootInvocation` trees name caller →
 *   callee → function exactly, for every call that needed authorisation.
 * - `event` — a contract event in the meta from another contract shows that
 *   contract ran, but not which call reached it or with what function.
 * - `footprint` — a foreign contract-instance key in the declared footprint
 *   shows another contract was touched, but not by which call.
 *
 * Diagnostic `fn_call` events would give the full tree, but public RPC
 * usually omits them for successful transactions, so they are not relied on
 * here; local sandbox traces (#542) cover that case. Transaction-level v4
 * events are fee charges/refunds by the native SAC on every transaction —
 * they say nothing about what the contract called and are ignored.
 *
 * Attribution: auth-tree edges come from the node that made the call. Event
 * and footprint evidence cannot name the caller, so it is attributed to the
 * transaction's top-level target only — the one contract whose invocation
 * tree certainly contains the touched contract — and only for contracts the
 * auth tree has not already placed under a known caller.
 *
 * Pure: XDR in, plain data out. No I/O, no DOM.
 */

import { classifyLedgerKey } from '@signet/spec';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';

/** How an edge is known, weakest to strongest. */
export type CallEvidence = 'footprint' | 'event' | 'auth-tree';

const EVIDENCE_RANK: Record<CallEvidence, number> = { footprint: 0, event: 1, 'auth-tree': 2 };

/** One observed call from `from` to `to` within one transaction. */
export interface CallEdge {
  from: string;
  to: string;
  /** Present only when the evidence names it (auth-tree). */
  function?: string;
  evidence: CallEvidence;
}

type EnvelopeInput = xdr.TransactionEnvelope | string;
type MetaInput = xdr.TransactionMeta | string | null | undefined;

function decodeEnvelope(envelope: EnvelopeInput): xdr.TransactionEnvelope {
  return typeof envelope === 'string'
    ? xdr.TransactionEnvelope.fromXDR(envelope, 'base64')
    : envelope;
}

function decodeMeta(meta: MetaInput): xdr.TransactionMeta | null {
  if (meta == null) return null;
  return typeof meta === 'string' ? xdr.TransactionMeta.fromXDR(meta, 'base64') : meta;
}

function innerTransaction(envelope: xdr.TransactionEnvelope): xdr.Transaction | null {
  switch (envelope.switch().name) {
    case 'envelopeTypeTx':
      return envelope.v1().tx();
    case 'envelopeTypeTxFeeBump':
      return envelope.feeBump().tx().innerTx().v1().tx();
    default:
      return null;
  }
}

function contractAddress(scAddress: xdr.ScAddress): string | null {
  return scAddress.switch().name === 'scAddressTypeContract'
    ? Address.fromScAddress(scAddress).toString()
    : null;
}

interface InvokeOp {
  target: string | null;
  functionName: string | null;
  auth: xdr.SorobanAuthorizationEntry[];
}

function invokeOps(tx: xdr.Transaction): InvokeOp[] {
  const ops: InvokeOp[] = [];
  for (const op of tx.operations()) {
    const body = op.body();
    if (body.switch().name !== 'invokeHostFunction') continue;
    const ihf = body.invokeHostFunctionOp();
    const hostFn = ihf.hostFunction();
    let target: string | null = null;
    let functionName: string | null = null;
    if (hostFn.switch().name === 'hostFunctionTypeInvokeContract') {
      const inv = hostFn.invokeContract();
      target = contractAddress(inv.contractAddress());
      functionName = inv.functionName().toString();
    }
    ops.push({ target, functionName, auth: ihf.auth() });
  }
  return ops;
}

interface AuthNode {
  contract: string | null;
  functionName: string | null;
  children: AuthNode[];
}

function authNode(inv: xdr.SorobanAuthorizedInvocation): AuthNode {
  const fn = inv.function();
  let contract: string | null = null;
  let functionName: string | null = null;
  if (fn.switch().name === 'sorobanAuthorizedFunctionTypeContractFn') {
    const args = fn.contractFn();
    contract = contractAddress(args.contractAddress());
    functionName = args.functionName().toString();
  }
  return { contract, functionName, children: inv.subInvocations().map(authNode) };
}

function walk(
  node: AuthNode,
  visit: (node: AuthNode, parent: AuthNode | null) => void,
  parent: AuthNode | null = null,
) {
  visit(node, parent);
  for (const child of node.children) walk(child, visit, node);
}

function authTrees(op: InvokeOp): AuthNode[] {
  return op.auth.map((entry) => authNode(entry.rootInvocation()));
}

/**
 * Contracts whose instance the declared footprint touches, other than
 * `contract` itself — #509's `foreign-contract-instance` keys. Foreign
 * *data* keys are not counted: another contract's storage is reached through
 * that contract, whose instance is then in the footprint too.
 */
function foreignInstances(tx: xdr.Transaction, contract: string): string[] {
  const ext = tx.ext();
  if (ext.switch() !== 1) return [];
  const footprint = ext.sorobanData().resources().footprint();
  const ids = new Set<string>();
  for (const key of [...footprint.readOnly(), ...footprint.readWrite()]) {
    const ref = classifyLedgerKey(key.toXDR('base64'), contract);
    if (ref.kind === 'foreign-contract-instance' && ref.owner) ids.add(ref.owner);
  }
  return [...ids];
}

/**
 * Contract ids that emitted contract events in the transaction's operations.
 * Excludes v4 transaction-level (fee) events and diagnostic events.
 */
export function eventContractIds(meta: MetaInput): string[] {
  const decoded = decodeMeta(meta);
  if (!decoded) return [];
  const events: xdr.ContractEvent[] = [];
  switch (decoded.switch()) {
    case 3:
      events.push(...(decoded.v3().sorobanMeta()?.events() ?? []));
      break;
    case 4:
      for (const op of decoded.v4().operations()) events.push(...op.events());
      break;
  }
  const ids = new Set<string>();
  for (const event of events) {
    const id = event.contractId();
    if (id) ids.add(StrKey.encodeContract(id as unknown as Buffer));
  }
  return [...ids];
}

/**
 * The function `contract` was invoked with: the top-level function when it is
 * the host function's target, otherwise the first auth-tree node that names
 * it as a sub-call target. Null when nothing in the transaction names it.
 */
export function invokedFunction(envelope: EnvelopeInput, contract: string): string | null {
  const tx = innerTransaction(decodeEnvelope(envelope));
  if (!tx) return null;
  const ops = invokeOps(tx);
  for (const op of ops) {
    if (op.target === contract && op.functionName) return op.functionName;
  }
  for (const op of ops) {
    let found: string | null = null;
    for (const tree of authTrees(op)) {
      walk(tree, (node) => {
        if (found === null && node.contract === contract) found = node.functionName;
      });
      if (found !== null) return found;
    }
  }
  return null;
}

/** Call edges out of `contract` observed in one transaction. */
export function callEdgesFromTransaction(
  envelope: EnvelopeInput,
  meta: MetaInput,
  contract: string,
): CallEdge[] {
  const tx = innerTransaction(decodeEnvelope(envelope));
  if (!tx) return [];
  const ops = invokeOps(tx);

  const edges: CallEdge[] = [];
  const authEdgeKeys = new Set<string>();
  const authCallees = new Set<string>();
  // Contracts whose caller the auth tree names — event/footprint evidence
  // about them must not be re-attributed to the top-level target.
  const placedUnderCaller = new Set<string>();

  for (const op of ops) {
    for (const tree of authTrees(op)) {
      walk(tree, (node, parent) => {
        if (!parent || !node.contract || !parent.contract || node.contract === parent.contract)
          return;
        placedUnderCaller.add(node.contract);
        if (parent.contract !== contract) return;
        const key = `${node.contract}\u0000${node.functionName ?? ''}`;
        if (authEdgeKeys.has(key)) return;
        authEdgeKeys.add(key);
        authCallees.add(node.contract);
        const edge: CallEdge = { from: contract, to: node.contract, evidence: 'auth-tree' };
        if (node.functionName) edge.function = node.functionName;
        edges.push(edge);
      });
    }
  }

  if (!ops.some((op) => op.target === contract)) return edges;

  const weak = new Map<string, CallEvidence>();
  const consider = (to: string, evidence: CallEvidence) => {
    if (to === contract || authCallees.has(to) || placedUnderCaller.has(to)) return;
    const current = weak.get(to);
    if (!current || EVIDENCE_RANK[evidence] > EVIDENCE_RANK[current]) weak.set(to, evidence);
  };
  for (const id of foreignInstances(tx, contract)) consider(id, 'footprint');
  for (const id of eventContractIds(meta)) consider(id, 'event');

  for (const [to, evidence] of [...weak].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    edges.push({ from: contract, to, evidence });
  }
  return edges;
}

/** One stored invocation as far as aggregation is concerned. */
export interface CallEdgeRow {
  ledger: number;
  callEdges: readonly CallEdge[] | null | undefined;
}

/** A call edge weighted across many transactions. */
export interface AggregatedCallEdge {
  to: string;
  /** Distinct function names any evidence named, sorted. */
  functions: string[];
  /** Number of transactions that showed this edge. */
  count: number;
  strongestEvidence: CallEvidence;
  firstLedger: number;
  lastLedger: number;
}

/**
 * Weighted edges over a contract's stored invocations, heaviest first (ties
 * by callee address). A transaction counts once per callee, however many
 * functions or evidence kinds it showed.
 */
export function aggregateCallEdges(rows: readonly CallEdgeRow[]): AggregatedCallEdge[] {
  const byTo = new Map<string, AggregatedCallEdge & { fnSet: Set<string> }>();
  for (const row of rows) {
    const seenInRow = new Set<string>();
    for (const edge of row.callEdges ?? []) {
      let agg = byTo.get(edge.to);
      if (!agg) {
        agg = {
          to: edge.to,
          functions: [],
          fnSet: new Set(),
          count: 0,
          strongestEvidence: edge.evidence,
          firstLedger: row.ledger,
          lastLedger: row.ledger,
        };
        byTo.set(edge.to, agg);
      }
      if (!seenInRow.has(edge.to)) {
        seenInRow.add(edge.to);
        agg.count++;
        agg.firstLedger = Math.min(agg.firstLedger, row.ledger);
        agg.lastLedger = Math.max(agg.lastLedger, row.ledger);
      }
      if (edge.function) agg.fnSet.add(edge.function);
      if (EVIDENCE_RANK[edge.evidence] > EVIDENCE_RANK[agg.strongestEvidence]) {
        agg.strongestEvidence = edge.evidence;
      }
    }
  }
  return [...byTo.values()]
    .map(({ fnSet, ...agg }) => ({ ...agg, functions: [...fnSet].sort() }))
    .sort((a, b) => b.count - a.count || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
}
