import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCallEdges, callEdgesFromTransaction, eventContractIds, invokedFunction } from './calls.ts';
import sacTransferFixture from '../../../fixtures/data/sac-transfer-call-get-transaction.json' with { type: 'json' };
import footprintOnlyFixture from '../../../fixtures/data/footprint-only-call-get-transaction.json' with { type: 'json' };
import claimFixture from '../../../fixtures/data/claim-get-transaction.json' with { type: 'json' };

// All three are real testnet getTransaction responses (packages/fixtures).
const LENDING = 'CBXZBQ6NW3TGPGLTR4JCG2VPVWFLCCHKDW75NJIXYXV7CJLNUO64VTFC';
const SAC = 'CBM44TNMCPYIFJO4PSMDZA7IXKJRRNHA6EOWNWI3X4V47DDC7WQXXD3E';
const FOREIGN = 'CAITA5YIDBY4WQU7C5DUOM2P6BWZDFCKFCGOSUVDHZH3O3T7XKOAYOZR';
const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

test('a contract calling a Stellar Asset Contract transfer: the auth tree names caller, callee and function', () => {
  const { envelopeXdr, resultMetaXdr } = sacTransferFixture.payload;
  const edges = callEdgesFromTransaction(envelopeXdr, resultMetaXdr, LENDING);
  assert.deepEqual(edges, [
    { from: LENDING, to: SAC, function: 'transfer', evidence: 'auth-tree' },
    // The same transaction also reads a foreign instance nothing else names.
    { from: LENDING, to: FOREIGN, evidence: 'footprint' },
  ]);
});

test('a footprint-only foreign instance: an edge with evidence footprint and no function', () => {
  const { envelopeXdr, resultMetaXdr } = footprintOnlyFixture.payload;
  const edges = callEdgesFromTransaction(envelopeXdr, resultMetaXdr, LENDING);
  const foreign = edges.find((e) => e.to === FOREIGN);
  assert.deepEqual(foreign, { from: LENDING, to: FOREIGN, evidence: 'footprint' });
  assert.equal('function' in foreign!, false);
  // The SAC paid out without needing authorisation: it is in the footprint
  // too, but its transfer event is the stronger evidence that it ran.
  assert.deepEqual(
    edges.find((e) => e.to === SAC),
    { from: LENDING, to: SAC, evidence: 'event' },
  );
  assert.equal(edges.length, 2);
});

test('a self-only call has no edges, and the per-transaction fee events are not evidence', () => {
  const { envelopeXdr, resultMetaXdr } = claimFixture.payload;
  assert.deepEqual(callEdgesFromTransaction(envelopeXdr, resultMetaXdr, REGISTRY), []);
  // The native SAC's fee charge/refund events live at transaction level.
  assert.equal(eventContractIds(resultMetaXdr).includes(NATIVE_SAC), false);
});

test('a sub-call target gets no edges of its own from the caller\'s evidence', () => {
  const { envelopeXdr, resultMetaXdr } = sacTransferFixture.payload;
  assert.deepEqual(callEdgesFromTransaction(envelopeXdr, resultMetaXdr, SAC), []);
});

test('invokedFunction: top-level name for the target, auth-tree name for a sub-call target', () => {
  assert.equal(invokedFunction(sacTransferFixture.payload.envelopeXdr, LENDING), 'repay_obligation_liquidity');
  assert.equal(invokedFunction(sacTransferFixture.payload.envelopeXdr, SAC), 'transfer');
  // Reached without authorisation: nothing names the function.
  assert.equal(invokedFunction(footprintOnlyFixture.payload.envelopeXdr, SAC), null);
});

test('eventContractIds lists operation-level contract events only', () => {
  assert.deepEqual(eventContractIds(sacTransferFixture.payload.resultMetaXdr).sort(), [LENDING, SAC].sort());
  assert.deepEqual(eventContractIds(null), []);
});

test('aggregateCallEdges weights edges by transaction and keeps the strongest evidence', () => {
  const sac = sacTransferFixture.payload;
  const fp = footprintOnlyFixture.payload;
  const rows = [
    { ledger: sac.ledger, callEdges: callEdgesFromTransaction(sac.envelopeXdr, sac.resultMetaXdr, LENDING) },
    { ledger: fp.ledger, callEdges: callEdgesFromTransaction(fp.envelopeXdr, fp.resultMetaXdr, LENDING) },
    { ledger: 1, callEdges: null },
  ];
  const first = Math.min(sac.ledger, fp.ledger);
  const last = Math.max(sac.ledger, fp.ledger);
  assert.deepEqual(aggregateCallEdges(rows), [
    { to: FOREIGN, functions: [], count: 2, strongestEvidence: 'footprint', firstLedger: first, lastLedger: last },
    { to: SAC, functions: ['transfer'], count: 2, strongestEvidence: 'auth-tree', firstLedger: first, lastLedger: last },
  ]);
});

test('aggregateCallEdges counts a transaction once per callee', () => {
  const rows = [
    {
      ledger: 10,
      callEdges: [
        { from: LENDING, to: SAC, function: 'transfer', evidence: 'auth-tree' as const },
        { from: LENDING, to: SAC, function: 'approve', evidence: 'auth-tree' as const },
      ],
    },
  ];
  assert.deepEqual(aggregateCallEdges(rows), [
    { to: SAC, functions: ['approve', 'transfer'], count: 1, strongestEvidence: 'auth-tree', firstLedger: 10, lastLedger: 10 },
  ]);
});
