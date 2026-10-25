/**
 * @file Activity overlay (#518): aggregation, summary, sparkline, heat bars
 * and `rankByFrequency`.
 *
 * `UPDATE_GOLDEN=1 pnpm --filter @signet/visualiser test` rewrites the golden.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';
import {
  aggregateActivity,
  coverageNote,
  describeActivity,
  renderActivitySparkline,
  type ActivityCall,
} from './activity.ts';
import { buildContractGraph } from './graph.ts';
import { layoutContractGraph } from './layout.ts';
import { FIXTURES_DIR, loadFixture } from './load-fixture.ts';
import { renderDiagramSvg } from './render.ts';

const NOW = Date.UTC(2026, 9, 25, 14, 30); // 2026-10-25 14:30 UTC
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const call = (fn: string, ago: number): ActivityCall => ({ function: fn, createdAt: new Date(NOW - ago) });

test('24h buckets by hour, 7d and 30d by day, the newest bucket holding now', () => {
  const calls = [call('swap', 10 * 60_000), call('swap', 2 * HOUR), call('quote', 2 * HOUR), call('swap', 3 * DAY)];
  const day = aggregateActivity(calls, '24h', NOW);
  assert.equal(day.series.buckets.length, 24);
  assert.equal(day.series.buckets.at(-1)!.start, Date.UTC(2026, 9, 25, 14));
  assert.equal(day.series.total, 3);
  assert.deepEqual(day.counts, { swap: 2, quote: 1 });
  assert.equal(day.series.peak!.count, 2);

  const week = aggregateActivity(calls, '7d', NOW);
  assert.equal(week.series.buckets.length, 7);
  assert.equal(week.series.buckets.at(-1)!.start, Date.UTC(2026, 9, 25));
  assert.equal(week.series.total, 4);
  assert.deepEqual(week.counts, { swap: 3, quote: 1 });

  const month = aggregateActivity([...calls, call('swap', 40 * DAY)], '30d', NOW);
  assert.equal(month.series.buckets.length, 30);
  assert.equal(month.series.total, 4, 'a call before the range is not counted');
});

test('the summary names the total and the peak; an empty history says so', () => {
  const week = aggregateActivity([call('swap', DAY), call('swap', DAY + 60_000), call('quote', 3 * DAY)], '7d', NOW, {
    oldestStored: NOW - 3 * DAY,
  });
  assert.equal(describeActivity(week.series), '3 transactions in the last 7 days, peak on 2026-10-24 (2).');
  const empty = aggregateActivity([], '7d', NOW);
  assert.equal(describeActivity(empty.series), 'No activity recorded yet.');
  const quiet = aggregateActivity([], '24h', NOW, { oldestStored: NOW - 10 * DAY, lastActivity: NOW - 9 * DAY });
  assert.equal(describeActivity(quiet.series), 'No transactions in the last 24 hours.');
  const floor = aggregateActivity([call('swap', HOUR)], '24h', NOW, { totalIsFloor: true, oldestStored: NOW - HOUR });
  assert.match(describeActivity(floor.series), /^1\+ transaction in the last 24 hours/);
});

test('a range longer than the stored calls says how much it covers', () => {
  const week = aggregateActivity([call('swap', DAY)], '30d', NOW, { oldestStored: NOW - 5 * DAY });
  assert.equal(coverageNote(week.series), 'Counted only since 2026-10-20: 6 of the 30 days.');
  // countedSince, when later than the oldest stored call, wins.
  const counted = aggregateActivity([], '7d', NOW, { oldestStored: NOW - 6 * DAY, countedSince: NOW - 2 * DAY });
  assert.equal(coverageNote(counted.series), 'Counted only since 2026-10-23: 3 of the 7 days.');
  const covered = aggregateActivity([], '7d', NOW, { oldestStored: NOW - 60 * DAY });
  assert.equal(coverageNote(covered.series), null);
});

test('the sparkline is one line, tokens only, named by its summary, not animated', () => {
  const { series } = aggregateActivity([call('swap', DAY), call('swap', 2 * DAY)], '7d', NOW, { oldestStored: NOW - 2 * DAY });
  const svg = renderActivitySparkline(series, { idPrefix: 'a-' });
  assert.match(svg, /role="img" aria-labelledby="a-spark-title"/);
  assert.match(svg, /<title id="a-spark-title">2 transactions in the last 7 days, peak on/);
  assert.equal((svg.match(/<polyline/g) ?? []).length, 1);
  assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b|<animate|<script/);
});

// Soroswap's router groups `get_*` functions; observed use reorders them.
const counts = { get_amounts_in: 40, get_reserves: 12, get_factory: 0, swap_exact_tokens_for_tokens: 90 };
const GOLDEN = join(FIXTURES_DIR, '__golden__', 'activity', 'soroswap-router.svg');

function column(rankByFrequency: boolean) {
  const model = layoutContractGraph(buildContractGraph(loadFixture('soroswap-router')), {}, {
    activity: { counts, rankByFrequency },
  });
  const getGroup = model.groups.find((g) => g.name === 'get')!;
  return { model, get: getGroup.nodeIds.map((id) => id.slice(3)) };
}

test('rankByFrequency orders a group by use, and only with the flag', () => {
  assert.deepEqual(column(true).get.slice(0, 2), ['get_amounts_in', 'get_reserves']);
  assert.deepEqual(column(false).get, [
    'get_factory',
    'get_reserves',
    'get_amount_out',
    'get_amount_in',
    'get_amounts_out',
    'get_amounts_in',
  ]);
  // A group with no counts keeps spec order.
  const router = (m: ReturnType<typeof column>['model']) => m.groups.find((g) => g.name === 'router')!.nodeIds;
  assert.deepEqual(router(column(true).model), router(column(false).model));
});

test('golden: soroswap-router with heat bars, ranked by frequency', () => {
  const svg = `${renderDiagramSvg(column(true).model, {
    idPrefix: 'activity-',
    hrefForNode: () => null,
    title: 'soroswap-router, observed use',
  })}\n`;
  if (env.UPDATE_GOLDEN === '1') {
    mkdirSync(join(FIXTURES_DIR, '__golden__', 'activity'), { recursive: true });
    if (!existsSync(GOLDEN) || readFileSync(GOLDEN, 'utf8') !== svg) writeFileSync(GOLDEN, svg);
  }
  assert.ok(existsSync(GOLDEN), 'no golden; run with UPDATE_GOLDEN=1');
  assert.equal(svg, readFileSync(GOLDEN, 'utf8'));
  // Zero is the text "0", never an empty bar.
  const factory = svg.slice(svg.indexOf('data-node-id="fn:get_factory"'));
  const heat = factory.slice(factory.indexOf('<g class="diagram-heat"'), factory.indexOf('</g>') + 4);
  assert.match(heat, /data-uses="0"/);
  assert.match(heat, />0<\/text>/);
  assert.doesNotMatch(heat, /diagram-heat-bar/);
  assert.match(svg, /data-uses="90"[^]*?class="diagram-heat-bar"/);
});
