import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_TABS, contractTabHref, SIGNET_DEV_RELEASED } from './contract-tabs.ts';

test('tabs are in the order the design fixes', () => {
  assert.deepEqual(
    CONTRACT_TABS.map((t) => t.label),
    ['Overview', 'Functions', 'Types', 'Diagram', 'Run locally', 'Activity'],
  );
});

test('segments are unique (one null for the index, no duplicates)', () => {
  const segments = CONTRACT_TABS.map((t) => t.segment);
  assert.equal(new Set(segments).size, segments.length);
  assert.equal(segments.filter((s) => s === null).length, 1);
});

test('ids are unique and stable', () => {
  const ids = CONTRACT_TABS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('hrefs put the index at the base route and every other tab under its segment', () => {
  const [overview, functions] = CONTRACT_TABS;
  assert.equal(contractTabHref('alice', 'CABC', overview!), '/p/alice/contract/CABC');
  assert.equal(contractTabHref('alice', 'CABC', functions!), '/p/alice/contract/CABC/functions');
});

test('SIGNET_DEV_RELEASED is false by default (gates signet dev command)', () => {
  assert.equal(SIGNET_DEV_RELEASED, false);
});
