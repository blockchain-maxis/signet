import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCallGraph, describeCallWindow, type CallGraphRow } from './call-graph.ts';
import type { CallNode } from './sandbox.ts';

const SELF = 'CSELF';
const SAC = 'CSAC';
const ORACLE = 'CORACLE';

const row = (
  ledger: number,
  fn: string | null,
  ...edges: [string, 'auth-tree' | 'event' | 'footprint'][]
): CallGraphRow => ({
  ledger,
  function: fn,
  callEdges: edges.map(([to, evidence]) => ({ from: SELF, to, evidence })),
});

const node = (contract: string, fn: string, children: CallNode[] = []): CallNode => ({
  contract,
  function: fn,
  wasmHash: null,
  argsXdr: [],
  argsExact: true,
  resultXdr: null,
  error: null,
  children,
});

test('edges are per calling function, counted per transaction, with their strongest evidence', () => {
  const overlay = buildCallGraph(SELF, [
    row(100, 'repay', [SAC, 'footprint'], [SAC, 'auth-tree']),
    row(101, 'repay', [SAC, 'event']),
    row(102, 'borrow', [ORACLE, 'footprint'], [SAC, 'auth-tree']),
    row(103, null, [ORACLE, 'event']),
    row(104, 'refresh'),
  ]);
  assert.deepEqual(overlay.edges, [
    { from: 'repay', to: SAC, transactions: 2, evidence: 'auth-tree', sandboxRuns: 0 },
    { from: null, to: ORACLE, transactions: 1, evidence: 'event', sandboxRuns: 0 },
    { from: 'borrow', to: ORACLE, transactions: 1, evidence: 'footprint', sandboxRuns: 0 },
    { from: 'borrow', to: SAC, transactions: 1, evidence: 'auth-tree', sandboxRuns: 0 },
  ]);
  assert.equal(overlay.transactions, 5, 'every stored invocation is the window, calls or not');
  assert.deepEqual([overlay.firstLedger, overlay.lastLedger], [100, 104]);
});

test("edges out of another contract, or back into this one, are not this contract's calls", () => {
  const overlay = buildCallGraph(SELF, [
    {
      ledger: 1,
      function: 'f',
      callEdges: [
        { from: 'COTHER', to: SAC, evidence: 'auth-tree' },
        { from: SELF, to: SELF, evidence: 'event' },
      ],
    },
  ]);
  assert.deepEqual(overlay.edges, []);
});

test('sandbox runs add their direct calls out of this contract, once per run', () => {
  const run = [
    node(SELF, 'repay', [node(SAC, 'transfer'), node(SAC, 'transfer', [node(ORACLE, 'price')])]),
  ];
  const overlay = buildCallGraph(SELF, [row(7, 'repay', [SAC, 'auth-tree'])], [run, run]);
  assert.deepEqual(
    overlay.edges,
    [{ from: 'repay', to: SAC, transactions: 1, evidence: 'auth-tree', sandboxRuns: 2 }],
    'the SAC calling the oracle is the SAC’s call, not this contract’s',
  );
  assert.equal(overlay.sandboxRuns, 2);
});

test('the provenance line names the window', () => {
  assert.equal(
    describeCallWindow({ transactions: 12, firstLedger: 100, lastLedger: 250, sandboxRuns: 2 }),
    'Calls observed in 12 transactions (ledgers 100–250) and 2 local sandbox runs. Calls that never happened in that window aren’t shown.',
  );
  assert.equal(
    describeCallWindow({ transactions: 1, firstLedger: 7, lastLedger: 7, sandboxRuns: 0 }),
    'Calls observed in 1 transaction (ledger 7) and 0 local sandbox runs. Calls that never happened in that window aren’t shown.',
  );
});
