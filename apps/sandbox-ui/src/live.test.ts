import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoff, follow, initialLive, MAX_RECONNECTS, reduceLive, type LiveAction } from './live.ts';
import type { Api } from './api.ts';

test('a failed build sets the error, a completed cycle clears it and moves the cycle on', () => {
  let s = reduceLive(initialLive, { kind: 'event', event: { type: 'build.failed', data: { message: 'error[E0308]' } } });
  assert.equal(s.buildError, 'error[E0308]');
  s = reduceLive(s, { kind: 'event', event: { type: 'cycle.completed', data: { id: 7 } } });
  assert.deepEqual([s.buildError, s.cycleId, s.events.length], [null, 7, 2]);
  s = reduceLive(s, { kind: 'event', event: { type: 'drift', data: { count: 3 } } });
  assert.equal(s.drift, 3);
  assert.equal(reduceLive(s, { kind: 'dismiss', what: 'drift' }).drift, null);
});

test('backoff doubles from half a second to eight', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoff), [500, 1000, 2000, 4000, 8000, 8000]);
});

test('a stream that never opens is retried with backoff, then the session has ended', async () => {
  const seen: LiveAction[] = [];
  const waits: number[] = [];
  const api = { events: async () => Promise.reject(new Error('refused')) } as unknown as Api;
  await follow(api, (a) => seen.push(a), new AbortController().signal, async (ms) => void waits.push(ms));
  assert.equal(waits.length, MAX_RECONNECTS);
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(seen.at(-1), { kind: 'connection', connection: 'ended' });
});

test('a stream that opens resets the count of failures', async () => {
  let calls = 0;
  const seen: string[] = [];
  const abort = new AbortController();
  const api = {
    events: async (_on: unknown, _signal: unknown, onOpen?: () => void) => {
      calls++;
      if (calls % 2 === 0) onOpen?.();
      if (calls === 12) abort.abort();
      throw new Error('dropped');
    },
  } as unknown as Api;
  await follow(api, (a) => a.kind === 'connection' && seen.push(a.connection), abort.signal, async () => {});
  assert.ok(!seen.includes('ended'), 'a stream that keeps reopening is never taken to have ended');
  assert.ok(seen.includes('live') && seen.includes('reconnecting'));
});
