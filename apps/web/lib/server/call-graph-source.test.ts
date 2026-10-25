import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { __resetCalleeLabels } from './diagram.ts';
import { CALL_GRAPH_WINDOW, loadContractCallGraph } from './call-graph-source.ts';

const SELF = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const CALLEE = 'CAITA5YIDBY4WQU7C5DUOM2P6BWZDFCKFCGOSUVDHZH3O3T7XKOAYOZR';

const noChain = {
  server: { getLedgerEntries: async () => ({ entries: [] }) },
  findSignetContracts: async () => [],
};

beforeEach(() => __resetCalleeLabels());

test('stored invocations become the overlay, its callees labelled, over the newest window', async () => {
  let asked: unknown[] = [];
  const graph = await loadContractCallGraph(SELF, 'testnet', {
    listRows: async (...args) => {
      asked = args;
      return [
        {
          ledger: 9,
          function: 'claim',
          callEdges: [{ from: SELF, to: CALLEE, evidence: 'footprint' }],
        },
        { ledger: 8, function: 'claim', callEdges: null },
      ];
    },
    labels: noChain,
  });
  assert.deepEqual(asked, [SELF, 'testnet', CALL_GRAPH_WINDOW]);
  assert.deepEqual(graph!.overlay.edges, [
    { from: 'claim', to: CALLEE, transactions: 1, evidence: 'footprint', sandboxRuns: 0 },
  ]);
  assert.equal(graph!.overlay.transactions, 2);
  assert.equal(graph!.labels.get(CALLEE)!.text, 'CAIT…YOZR');
});

test('no rows, no calls or a failing read: no call graph, never an error', async () => {
  assert.equal(
    await loadContractCallGraph(SELF, 'testnet', { listRows: async () => undefined }),
    null,
  );
  assert.equal(
    await loadContractCallGraph(SELF, 'testnet', {
      listRows: async () => [{ ledger: 1, function: 'f', callEdges: [] }],
    }),
    null,
  );
  assert.equal(
    await loadContractCallGraph(SELF, 'testnet', {
      listRows: async () => {
        throw new Error('db down');
      },
    }),
    null,
  );
});
