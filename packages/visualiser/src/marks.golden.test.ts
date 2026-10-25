/**
 * @file Golden SVG of the read/write overlay (#512).
 *
 * The mid-size fixture (`soroswap-router`) with marks of every kind, as
 * `getMutabilityOverlay` (#511) hands them over: functions that move tokens
 * are seen writing, the quote and getter functions are seen not writing,
 * and the rest were never observed. The badge, its title, the key and the
 * provenance line under the diagram are all in the golden.
 *
 * `UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test` rewrites it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import type { MutabilityMark } from '@signet/spec';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph, MARK_SLOT } from './layout.ts';
import { FIXTURES_DIR, loadFixture } from './load-fixture.ts';
import { renderDiagramSvg, type MutabilityOverlayInput } from './render.ts';
import { buildDiagramOutline, renderOutlineHtml, withMarks } from './outline.ts';

const GOLDEN = join(FIXTURES_DIR, '__golden__', 'marks', 'soroswap-router.svg');
const counts = { staleObservations: 0, unversionedObservations: 0, seededObservations: 0 };

function markFor(name: string): MutabilityMark {
  if (/swap|liquidity/.test(name)) {
    return {
      kind: 'writes',
      evidence: 'changed',
      example: { source: 'transaction', ledger: 5_101_204, txHash: 'f'.repeat(64) },
      writingObservations: 3,
      observations: 4,
      seededOnly: false,
      ...counts,
    };
  }
  if (/^(get|quote|router_)/.test(name)) {
    return { kind: 'no-writes-seen', observations: 2, firstLedger: 5_100_870, lastLedger: 5_101_190, seededOnly: false, ...counts };
  }
  return { kind: 'unknown', ...counts };
}

function render(writesOnly?: boolean) {
  const spec = loadFixture('soroswap-router');
  const model = layoutContractGraph(buildContractGraph(spec));
  const marks = Object.fromEntries(spec.functions.map((f) => [f.name, markFor(f.name)]));
  const mutability: MutabilityOverlayInput = {
    marks,
    transactions: 11,
    firstLedger: 5_100_870,
    lastLedger: 5_101_204,
    staleObservations: 2,
    txHref: (tx) => `https://stellar.expert/explorer/testnet/tx/${tx}`,
  };
  const svg = renderDiagramSvg(model, {
    idPrefix: 'marks-',
    hrefForNode: (id) => (id.startsWith('fn:') ? `#fn-${id.slice(3)}` : null),
    title: 'soroswap-router with read/write marks',
    overlays: { mutability },
    writesOnly,
  });
  return { spec, model, marks, svg: `${svg}\n` };
}

test('golden: the router with observed writes, no writes seen, and never observed', () => {
  const { svg } = render();
  if (env.UPDATE_GOLDEN === '1') {
    mkdirSync(join(FIXTURES_DIR, '__golden__', 'marks'), { recursive: true });
    if (!existsSync(GOLDEN) || readFileSync(GOLDEN, 'utf8') !== svg) writeFileSync(GOLDEN, svg);
  }
  assert.ok(existsSync(GOLDEN), 'no golden; run with UPDATE_GOLDEN=1');
  assert.equal(svg, readFileSync(GOLDEN, 'utf8'), 'the marked diagram differs from its golden');
});

test('a mark sits in the slot the layout keeps, and says how it is known', () => {
  const { svg, model, spec } = render();
  for (const kind of ['write', 'read', 'unknown']) assert.ok(svg.includes(`data-mark="${kind}"`), kind);
  assert.match(svg, /Read\/write marks observed from 11 transactions between ledger 5100870 and 5101204 \(RPC keeps about 7 days\)\. Not derived from the contract interface\./);
  assert.match(svg, /2 calls to an earlier version of this contract not counted\./);
  assert.match(svg, /data-mark-href="https:\/\/stellar\.expert\/explorer\/testnet\/tx\/f{64}"/);
  // Every function node is wide enough for its label and the slot.
  for (const node of model.nodes.filter((n) => n.kind === 'function')) {
    assert.ok(node.width >= MARK_SLOT + 20, node.name);
  }
  assert.ok(spec.functions.length > 5);
});

test('a function never observed is never drawn as R', () => {
  const { svg, marks } = render();
  for (const [name, mark] of Object.entries(marks)) {
    if (mark.kind !== 'unknown') continue;
    const at = svg.indexOf(`data-node-id="fn:${name}"`);
    const node = svg.slice(at, svg.indexOf('</a>', at));
    assert.match(node, /data-mark="unknown"/, name);
    assert.doesNotMatch(node, />R</, name);
    assert.match(node, />\?</, name);
  }
});

test('the outline says each mark in words', () => {
  const { model, marks } = render();
  const html = renderOutlineHtml(withMarks(buildDiagramOutline(model), marks), () => null);
  assert.match(html, /\[writes\]/);
  assert.match(html, /\[no writes seen\]/);
  assert.match(html, /\[not observed\]/);
});

test('writes only dims every node but the functions seen writing', () => {
  const { svg, marks } = render(true);
  for (const [name, mark] of Object.entries(marks)) {
    const at = svg.indexOf(`data-node-id="fn:${name}"`);
    const tag = svg.slice(at, svg.indexOf('>', at));
    if (mark.kind === 'writes') assert.doesNotMatch(tag, /viz-dimmed/, name);
    else assert.match(tag, /viz-dimmed/, name);
  }
  // Without marks there is nothing to filter on, so nothing is dimmed.
  const plain = renderDiagramSvg(render().model, { idPrefix: 'p-', hrefForNode: () => null, title: 't', writesOnly: true });
  assert.doesNotMatch(plain, /viz-dimmed/);
});
