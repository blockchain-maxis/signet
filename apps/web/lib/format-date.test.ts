import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTimeUntil } from './format-date.ts';

const now = Date.UTC(2026, 10, 22, 12);
const minute = 60_000;

test('formatTimeUntil uses the largest whole unit and handles singular values', () => {
  assert.equal(formatTimeUntil(now + 2 * 24 * 60 * minute, now), 'in 2 days');
  assert.equal(formatTimeUntil(now + 3 * 60 * minute, now), 'in 3 hours');
  assert.equal(formatTimeUntil(now + minute, now), 'in 1 minute');
});

test('formatTimeUntil describes less than a minute without rounding up', () => {
  assert.equal(formatTimeUntil(now + minute - 1, now), 'in under a minute');
});
