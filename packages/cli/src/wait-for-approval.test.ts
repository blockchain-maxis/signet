import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForApproval, type PollState } from './wait-for-approval.ts';

/**
 * A fake clock that advances only when `sleep` is called, so the bounded-wait
 * loop can be driven forwards without real timers.
 */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function reportLines(report: { remainingMs: number }[]) {
  return report.map((r) => r.remainingMs);
}

async function runWait(stateSequence: PollState[], opts: { ttlMs?: number; pollIntervalMs?: number } = {}) {
  const { ttlMs = 10_000, pollIntervalMs = 2_000 } = opts;
  const clock = fakeClock(0);
  let i = 0;
  const report: { remainingMs: number }[] = [];
  const result = await waitForApproval({
    ttlMs,
    pollIntervalMs,
    getStatus: async () => stateSequence[Math.min(i++, stateSequence.length - 1)] ?? 'pending',
    sleep: clock.sleep,
    now: clock.now,
    report: (info) => report.push(info),
  });
  return { result, report };
}

test('returns approved when the browser approves after some pending polls', async () => {
  const { result, report } = await runWait(['pending', 'pending', 'approved']);
  assert.deepEqual(result, { outcome: 'approved' });
  // Initial "waiting" report plus a report after each pending poll.
  assert.deepEqual(reportLines(report), [10_000, 8_000, 6_000]);
});

test('returns rejected when the browser rejects', async () => {
  const { result } = await runWait(['pending', 'rejected']);
  assert.deepEqual(result, { outcome: 'rejected' });
});

test('returns expired when the server reports the pairing expired', async () => {
  const { result } = await runWait(['expired']);
  assert.deepEqual(result, { outcome: 'expired' });
});

test('times out exactly when the deadline (the pairing TTL) is reached — never later', async () => {
  const { result, report } = await runWait(
    Array(10).fill('pending'),
    { ttlMs: 10_000, pollIntervalMs: 2_000 },
  );
  assert.deepEqual(result, { outcome: 'timeout' });
  // Report stops before the deadline; no report past expiry, no late answer.
  assert.deepEqual(reportLines(report), [10_000, 8_000, 6_000, 4_000, 2_000]);
  const reports = report;
  assert.ok(reports.every((r) => r.remainingMs > 0), 'never reports a burned-out timer');
});

test('reports what it is waiting for immediately, before any poll', async () => {
  const clock = fakeClock(0);
  const report: { remainingMs: number }[] = [];
  await waitForApproval({
    ttlMs: 60_000,
    pollIntervalMs: 1000,
    getStatus: async () => 'approved' as PollState,
    sleep: clock.sleep,
    now: clock.now,
    report: (info) => report.push(info),
  });
  assert.deepEqual(reportLines(report), [60_000], 'first report is the full TTL');
});

test('TTL and the wait deadline come from the same value', async () => {
  // The CLI derives both the pair's validity and its own deadline from a single
  // ttlMs (the pairing code's TTL), so a shorter TTL shortens the wait.
  const { result } = await runWait(Array(20).fill('pending'), { ttlMs: 4_000, pollIntervalMs: 1_000 });
  assert.deepEqual(result, { outcome: 'timeout' });
});