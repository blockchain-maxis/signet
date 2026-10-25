/**
 * @file Golden SVG of a real call graph (#543).
 *
 * A testnet lending market (`fixtures/testnet-lending-market.spec.json`) and
 * two of its real transactions (`packages/fixtures`): a
 * `repay_obligation_liquidity` whose auth tree names a USDC Stellar Asset
 * Contract `transfer`, and a `borrow_obligation_liquidity` whose footprint
 * holds a contract nothing else names. The edges come from
 * `callEdgesFromTransaction` exactly as the indexer stores them, and the SAC's
 * label from its instance entry (`fixtures/calls/`), the way the web app
 * labels callees (#517).
 *
 * The interface is too large to draw, so the page draws the calls alone:
 * the calling functions and the callee column.
 *
 * `UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test` rewrites it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import sacTransfer from '../../fixtures/data/sac-transfer-call-get-transaction.json' with { type: 'json' };
import footprintOnly from '../../fixtures/data/footprint-only-call-get-transaction.json' with { type: 'json' };
import usdcInstance from '../fixtures/calls/usdc-sac-instance-entry.json' with { type: 'json' };
import { diagramDecision } from './decide.ts';
import { buildContractGraph } from './graph.ts';
import { calleeNodeId, layoutContractGraph } from './layout.ts';
import { FIXTURES_DIR, loadFixture } from './load-fixture.ts';
import { renderDiagramSvg } from './render.ts';
import { buildDiagramOutline, renderOutlineHtml } from './outline.ts';
import { callEdgesFromTransaction, invokedFunction } from './observe/calls.ts';
import { buildCallGraph, callersOnly } from './observe/call-graph.ts';

const LENDING = 'CBXZBQ6NW3TGPGLTR4JCG2VPVWFLCCHKDW75NJIXYXV7CJLNUO64VTFC';
const SAC = 'CBM44TNMCPYIFJO4PSMDZA7IXKJRRNHA6EOWNWI3X4V47DDC7WQXXD3E';
const FOREIGN = 'CAITA5YIDBY4WQU7C5DUOM2P6BWZDFCKFCGOSUVDHZH3O3T7XKOAYOZR';
const GOLDEN = join(FIXTURES_DIR, '__golden__', 'calls', 'testnet-lending-market.svg');

/** The label #517 gives a SAC: its asset, from the METADATA the host wrote. */
function sacLabel(entryXdr: string): string {
  const instance = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64').contractData().val().instance();
  const metadata = (instance.storage() ?? []).find((i) => scValToNative(i.key()) === 'METADATA')!;
  const [code, issuer] = (scValToNative(metadata.val()) as { name: string }).name.split(':');
  return `${code} (asset contract, issuer G…${issuer!.slice(-4)})`;
}

function render() {
  const rows = [sacTransfer, footprintOnly].map(({ payload }) => ({
    ledger: payload.ledger,
    function: invokedFunction(payload.envelopeXdr, LENDING),
    callEdges: callEdgesFromTransaction(payload.envelopeXdr, payload.resultMetaXdr, LENDING),
  }));
  const overlay = buildCallGraph(LENDING, rows);
  const full = buildContractGraph(loadFixture('testnet-lending-market'));
  const graph =
    diagramDecision(full, layoutContractGraph(full)).kind === 'draw'
      ? full
      : callersOnly(full, overlay);
  const labels = new Map([[SAC, sacLabel(usdcInstance.payload.entries[0]!.xdr)]]);
  const model = layoutContractGraph(graph, {}, { calls: { overlay, labels } });
  const svg = renderDiagramSvg(model, {
    idPrefix: 'calls-',
    hrefForNode: (id) =>
      id.startsWith('fn:')
        ? `#fn-${id.slice(3)}`
        : id.startsWith('callee:')
          ? `https://stellar.expert/explorer/testnet/contract/${id.slice(7)}`
          : null,
    title: `testnet-lending-market (testnet ${LENDING})`,
  });
  return { model, svg: `${svg}\n` };
}

test('golden: the lending market calls a USDC asset contract and a footprint-only contract', () => {
  const { svg } = render();
  if (env.UPDATE_GOLDEN === '1') {
    mkdirSync(join(FIXTURES_DIR, '__golden__', 'calls'), { recursive: true });
    if (!existsSync(GOLDEN) || readFileSync(GOLDEN, 'utf8') !== svg) writeFileSync(GOLDEN, svg);
    return;
  }
  assert.ok(
    existsSync(GOLDEN),
    'no golden; create it with UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test',
  );
  assert.equal(
    svg,
    readFileSync(GOLDEN, 'utf8'),
    'the call graph SVG changed; if deliberate, rerun with UPDATE_GOLDEN=1',
  );
});

test('what the golden shows: the right edges, labels and evidence', () => {
  const { model, svg } = render();
  const sac = model.nodes.find((n) => n.id === calleeNodeId(SAC))!;
  assert.equal(sac.label, 'USDC (asset contract, issuer G…LQQX)');
  assert.equal(model.nodes.find((n) => n.id === calleeNodeId(FOREIGN))!.label, 'CAIT…YOZR');

  // Each call by its calling function and its strongest evidence: repay's
  // auth tree names the SAC transfer; borrow's only shows the SAC's event.
  const calls = model.edges
    .filter((e) => e.call)
    .map((e) => `${e.from} -> ${e.to.slice(7, 11)} ${e.call!.evidence}`)
    .sort();
  assert.deepEqual(calls, [
    'fn:borrow_obligation_liquidity -> CAIT footprint',
    'fn:borrow_obligation_liquidity -> CBM4 event',
    'fn:repay_obligation_liquidity -> CAIT footprint',
    'fn:repay_obligation_liquidity -> CBM4 auth-tree',
  ]);

  assert.ok(svg.includes('data-edge-kind="call-auth-tree"'));
  assert.ok(svg.includes('data-edge-kind="call-footprint"'));
  assert.ok(svg.includes('data-edge-kind="call-event"'));
  assert.ok(
    svg.includes('Calls observed in 2 transactions (ledger 5273174) and 0 local sandbox runs.'),
  );
  assert.ok(!svg.includes('diagram-node--type'), 'calls alone: no types');
});

test('the outline says the same in text: each callee, who called it, how often and how we know', () => {
  const { model } = render();
  const html = renderOutlineHtml(buildDiagramOutline(model), () => null);
  assert.ok(html.includes('calls to other contracts'));
  assert.ok(
    html.includes(
      '<span>USDC (asset contract, issuer G…LQQX)</span>: called by <span>borrow_obligation_liquidity</span> (1 call, the callee emitted an event), <span>repay_obligation_liquidity</span> (1 call, named by an auth tree)',
    ),
    html,
  );
  assert.ok(html.includes('Calls observed in 2 transactions (ledger 5273174)'));
  assert.ok(!html.includes('uses <span>USDC'), 'a callee is not a type the function uses');
});
