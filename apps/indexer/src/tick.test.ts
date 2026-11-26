import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from './logger.ts';
import {
  idleUntilNextTick,
  PENDING_CHECK_INTERVAL_MS,
  runTick,
  runWorker,
  type TickWorkers,
} from './tick.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Line = { level: Level; message: string; fields: Record<string, unknown> };

/** Runs `fn` with the logger replaced, and returns what it logged. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: Line[] }> {
  const lines: Line[] = [];
  const original = { ...logger };
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    logger[level] = (fields, message) => {
      lines.push({ level, message, fields });
    };
  }
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(logger, original);
  }
}

/** The name each worker goes by in `failedWorkers`, in the order a tick runs them. */
const WORKER_KEYS = {
  attestation: 'attestation',
  deployment: 'deployment',
  activity: 'activity',
  operations: 'operations',
  invocations: 'invocations',
  'executable-refresh': 'executableRefresh',
  prune: 'prune',
} as const;
type WorkerName = keyof typeof WORKER_KEYS;
const WORKER_NAMES = Object.keys(WORKER_KEYS) as WorkerName[];

/**
 * A full set of fake workers. Each records that it ran and returns a count no
 * other worker returns, so a total that ends up in the wrong field shows.
 */
function fakeWorkers(): { workers: TickWorkers; ran: string[]; cursorSaves: number[] } {
  const ran: string[] = [];
  const cursorSaves: number[] = [];
  const ok =
    <T>(name: string, result: T) =>
    async (): Promise<T> => {
      ran.push(name);
      return result;
    };
  const workers: TickWorkers = {
    attestation: ok('attestation', { eventsDecoded: 2 }),
    deployment: ok('deployment', { highestLedger: 5_000, walletsScanned: 3, contractsFound: 1 }),
    activity: ok('activity', { snapshotsWritten: 4 }),
    operations: ok('operations', { opsUpserted: 7 }),
    invocations: ok('invocations', { invocationsUpserted: 6 }),
    executableRefresh: ok('executable-refresh', { wasmChanged: 5 }),
    prune: ok('prune', { opsPruned: 9, snapshotsPruned: 8, invocationsPruned: 10, pairingsPruned: 11 }),
    saveCursor: async (highestLedger) => {
      ran.push('cursor');
      cursorSaves.push(highestLedger);
    },
  };
  return { workers, ran, cursorSaves };
}

/** What a tick of {@link fakeWorkers} adds up to when nothing fails. */
const CLEAN_TOTALS = {
  walletsScanned: 3,
  eventsDecoded: 2,
  contractsFound: 1,
  opsUpserted: 7,
  invocationsUpserted: 6,
  snapshotsWritten: 4,
  wasmChanged: 5,
  opsPruned: 9,
  snapshotsPruned: 8,
  invocationsPruned: 10,
  pairingsPruned: 11,
};

/** The totals a worker contributes, which fall back to zero when it fails. */
const TOTALS_OF: Record<WorkerName, (keyof typeof CLEAN_TOTALS)[]> = {
  attestation: ['eventsDecoded'],
  deployment: ['walletsScanned', 'contractsFound'],
  activity: ['snapshotsWritten'],
  operations: ['opsUpserted'],
  invocations: ['invocationsUpserted'],
  'executable-refresh': ['wasmChanged'],
  prune: ['opsPruned', 'snapshotsPruned', 'invocationsPruned', 'pairingsPruned'],
};

const throwing = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

function totals(summary: Awaited<ReturnType<typeof runTick>>) {
  const { failedWorkers: _failed, durationMs: _duration, ...rest } = summary;
  return rest;
}

// ─── runWorker ──────────────────────────────────────────────────────────────

test('runWorker returns what the worker returned', async () => {
  const { result, lines } = await captureLogs(() =>
    runWorker('activity', async () => ({ snapshotsWritten: 4 }), { snapshotsWritten: 0 }),
  );
  assert.deepEqual(result, { result: { snapshotsWritten: 4 }, failed: false });
  assert.deepEqual(lines, []);
});

test('runWorker turns a rejection into the zero result and logs worker.failed', async () => {
  const { result, lines } = await captureLogs(() =>
    runWorker('activity', throwing('database is gone'), { snapshotsWritten: 0 }),
  );
  assert.deepEqual(result, { result: { snapshotsWritten: 0 }, failed: true });
  assert.deepEqual(lines, [
    {
      level: 'error',
      message: 'worker.failed',
      fields: { worker: 'activity', error: 'Error: database is gone' },
    },
  ]);
});

test('runWorker also catches a worker that throws before it returns a promise', async () => {
  const brokenBeforeAwait = (() => {
    throw new TypeError('reader is not a function');
  }) as () => Promise<{ opsUpserted: number }>;

  const { result, lines } = await captureLogs(() =>
    runWorker('operations', brokenBeforeAwait, { opsUpserted: 0 }),
  );
  assert.deepEqual(result, { result: { opsUpserted: 0 }, failed: true });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.fields.error, 'TypeError: reader is not a function');
});

// ─── runTick ────────────────────────────────────────────────────────────────

test('runTick runs every worker in order and adds up what they return', async () => {
  const { workers, ran, cursorSaves } = fakeWorkers();

  const { result: summary, lines } = await captureLogs(() => runTick(workers));

  assert.deepEqual(ran, [...WORKER_NAMES, 'cursor']);
  assert.deepEqual(totals(summary), CLEAN_TOTALS);
  assert.deepEqual(summary.failedWorkers, []);
  assert.ok(summary.durationMs >= 0);
  assert.deepEqual(cursorSaves, [5_000]);
  assert.deepEqual(
    lines.filter((l) => l.level === 'error' || l.level === 'warn'),
    [],
  );
});

test('an attestation worker that throws does not stop the deployment and operations workers', async () => {
  const { workers, ran, cursorSaves } = fakeWorkers();
  workers.attestation = throwing('soroban rpc is down');

  const { result: summary, lines } = await captureLogs(() => runTick(workers));

  assert.ok(ran.includes('deployment'), 'the deployment worker still ran');
  assert.ok(ran.includes('operations'), 'the operations worker still ran');
  assert.deepEqual(summary.failedWorkers, ['attestation']);
  // The workers that ran are counted in full; the one that failed counts as zero.
  assert.deepEqual(totals(summary), { ...CLEAN_TOTALS, eventsDecoded: 0 });
  assert.deepEqual(cursorSaves, [5_000]);
  assert.deepEqual(
    lines.filter((l) => l.level === 'error'),
    [
      {
        level: 'error',
        message: 'worker.failed',
        fields: { worker: 'attestation', error: 'Error: soroban rpc is down' },
      },
    ],
  );
});

for (const failing of WORKER_NAMES) {
  test(`a failing ${failing} worker leaves every other worker running`, async () => {
    const { workers, ran } = fakeWorkers();
    workers[WORKER_KEYS[failing]] = throwing(`${failing} broke`);

    const { result: summary } = await captureLogs(() => runTick(workers));

    assert.deepEqual(summary.failedWorkers, [failing]);
    // Every other worker ran, in the usual order. The `main` cursor is only
    // saved when the deployment worker reported a ledger to save.
    const expectedRan: string[] = WORKER_NAMES.filter((name) => name !== failing);
    if (failing !== 'deployment') expectedRan.push('cursor');
    assert.deepEqual(ran, expectedRan);

    const expected = { ...CLEAN_TOTALS };
    for (const field of TOTALS_OF[failing]) expected[field] = 0;
    assert.deepEqual(totals(summary), expected);
  });
}

test('runTick completes, and says so, when every worker fails', async () => {
  const { workers, ran } = fakeWorkers();
  for (const name of WORKER_NAMES) workers[WORKER_KEYS[name]] = throwing(`${name} broke`);

  const { result: summary, lines } = await captureLogs(() => runTick(workers));

  assert.deepEqual(summary.failedWorkers, WORKER_NAMES);
  assert.deepEqual(
    totals(summary),
    Object.fromEntries(Object.keys(CLEAN_TOTALS).map((field) => [field, 0])),
  );
  assert.deepEqual(ran, [], 'no cursor is saved without a ledger from the deployment worker');
  assert.deepEqual(
    lines.filter((l) => l.message === 'worker.failed').map((l) => l.fields.worker),
    WORKER_NAMES,
  );
  assert.equal(lines.filter((l) => l.message === 'tick.summary').length, 1);
});

test('a failed save of the main cursor is reported without losing the tick', async () => {
  const { workers, ran } = fakeWorkers();
  workers.saveCursor = throwing('cursor write failed');

  const { result: summary, lines } = await captureLogs(() => runTick(workers));

  assert.deepEqual(ran, WORKER_NAMES);
  assert.deepEqual(summary.failedWorkers, ['cursor']);
  assert.deepEqual(totals(summary), CLEAN_TOTALS);
  assert.deepEqual(
    lines.filter((l) => l.message === 'worker.failed').map((l) => l.fields),
    [{ worker: 'cursor', error: 'Error: cursor write failed' }],
  );
});

test('the main cursor is not saved when the deployment worker saw no ledger', async () => {
  const { workers, ran, cursorSaves } = fakeWorkers();
  workers.deployment = async () => ({ highestLedger: 0, walletsScanned: 3, contractsFound: 0 });

  const { result: summary } = await captureLogs(() => runTick(workers));

  assert.deepEqual(cursorSaves, []);
  assert.ok(!ran.includes('cursor'));
  assert.deepEqual(summary.failedWorkers, []);
});

test('runTick leaves out the invocations and prune workers when they are not passed', async () => {
  const { workers, ran } = fakeWorkers();
  delete workers.invocations;
  delete workers.prune;

  const { result: summary } = await captureLogs(() => runTick(workers));

  assert.deepEqual(ran, [
    'attestation',
    'deployment',
    'activity',
    'operations',
    'executable-refresh',
    'cursor',
  ]);
  assert.deepEqual(totals(summary), {
    ...CLEAN_TOTALS,
    invocationsUpserted: 0,
    opsPruned: 0,
    snapshotsPruned: 0,
    invocationsPruned: 0,
    pairingsPruned: 0,
  });
  assert.deepEqual(summary.failedWorkers, []);
});

test('tick.summary is logged once, at info, with failedWorkers in it', async () => {
  const { workers } = fakeWorkers();
  workers.operations = throwing('horizon is down');

  const { result: summary, lines } = await captureLogs(() => runTick(workers));

  const summaries = lines.filter((l) => l.message === 'tick.summary');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.level, 'info');
  assert.deepEqual(summaries[0]!.fields, summary);
  assert.deepEqual(summaries[0]!.fields.failedWorkers, ['operations']);
});

// ─── idleUntilNextTick ──────────────────────────────────────────────────────

/** A clock that moves only when the loop sleeps, so no test waits. */
function fakeClock(startAt = 1_700_000_000_000) {
  let time = startAt;
  let sleeps = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      sleeps++;
      time += ms;
    },
    elapsed: () => time - startAt,
    sleeps: () => sleeps,
  };
}

const TICK_INTERVAL_MS = 30_000;
/** Checks at 0.25 s, 2.25 s, ... 28.25 s of a 30 s sleep. */
const CHECKS_PER_INTERVAL = TICK_INTERVAL_MS / PENDING_CHECK_INTERVAL_MS;

test('idleUntilNextTick keeps sleeping when the pending-request check throws once', async (t) => {
  // In `index.ts` an error that leaves this loop shuts the indexer down. Make
  // sure nothing here reaches for the exit either.
  const exit = t.mock.method(process, 'exit', () => {
    throw new Error('process.exit was called');
  });
  const clock = fakeClock();
  let checks = 0;

  const { lines } = await captureLogs(() =>
    idleUntilNextTick({
      intervalMs: TICK_INTERVAL_MS,
      isShuttingDown: () => false,
      hasPendingIndexRequest: async () => {
        checks++;
        if (checks === 1) throw new Error("Can't reach database server at `localhost:5432`");
        return false;
      },
      sleep: clock.sleep,
      now: clock.now,
    }),
  );

  // The promise resolved rather than rejected, the loop went on checking, and
  // it slept out the whole interval.
  assert.equal(checks, CHECKS_PER_INTERVAL);
  assert.equal(clock.elapsed(), TICK_INTERVAL_MS);
  assert.equal(exit.mock.callCount(), 0);
  assert.deepEqual(lines, [
    {
      level: 'warn',
      message: 'tick.pendingCheckFailed',
      fields: { error: "Error: Can't reach database server at `localhost:5432`" },
    },
  ]);
});

test('idleUntilNextTick warns on every failed check and still sleeps the whole interval', async () => {
  const clock = fakeClock();

  const { lines } = await captureLogs(() =>
    idleUntilNextTick({
      intervalMs: TICK_INTERVAL_MS,
      isShuttingDown: () => false,
      hasPendingIndexRequest: throwing('database is gone'),
      sleep: clock.sleep,
      now: clock.now,
    }),
  );

  assert.equal(clock.elapsed(), TICK_INTERVAL_MS);
  assert.equal(lines.length, CHECKS_PER_INTERVAL);
  assert.ok(lines.every((l) => l.level === 'warn' && l.message === 'tick.pendingCheckFailed'));
});

test('idleUntilNextTick ends the sleep early when a wallet is waiting to be indexed', async () => {
  const clock = fakeClock();
  let checks = 0;

  const { lines } = await captureLogs(() =>
    idleUntilNextTick({
      intervalMs: TICK_INTERVAL_MS,
      isShuttingDown: () => false,
      hasPendingIndexRequest: async () => {
        checks++;
        return true;
      },
      sleep: clock.sleep,
      now: clock.now,
    }),
  );

  assert.equal(checks, 1);
  assert.equal(clock.elapsed(), 250);
  assert.deepEqual(lines, [{ level: 'debug', message: 'tick.pendingIndexRequest', fields: {} }]);
});

test('a failed check does not hide the pending request the next check finds', async () => {
  const clock = fakeClock();
  let checks = 0;

  await captureLogs(() =>
    idleUntilNextTick({
      intervalMs: TICK_INTERVAL_MS,
      isShuttingDown: () => false,
      hasPendingIndexRequest: async () => {
        checks++;
        if (checks === 1) throw new Error('database is gone');
        return true;
      },
      sleep: clock.sleep,
      now: clock.now,
    }),
  );

  assert.equal(checks, 2);
  assert.equal(clock.elapsed(), 250 + PENDING_CHECK_INTERVAL_MS);
});

test('idleUntilNextTick asks about pending requests every two seconds, not on every wake', async () => {
  const clock = fakeClock();
  let checks = 0;

  await captureLogs(() =>
    idleUntilNextTick({
      intervalMs: 5_000,
      isShuttingDown: () => false,
      hasPendingIndexRequest: async () => {
        checks++;
        return false;
      },
      sleep: clock.sleep,
      now: clock.now,
    }),
  );

  assert.equal(clock.sleeps(), 20);
  // At 0.25 s, 2.25 s and 4.25 s.
  assert.equal(checks, 3);
});

test('idleUntilNextTick stops sleeping as soon as the indexer is shutting down', async () => {
  const clock = fakeClock();

  await captureLogs(() =>
    idleUntilNextTick({
      intervalMs: TICK_INTERVAL_MS,
      isShuttingDown: () => clock.elapsed() >= 1_000,
      hasPendingIndexRequest: async () => false,
      sleep: clock.sleep,
      now: clock.now,
    }),
  );

  assert.equal(clock.elapsed(), 1_000);
});

test('idleUntilNextTick does not sleep or query at all when already shutting down', async () => {
  const clock = fakeClock();
  let checks = 0;

  await captureLogs(() =>
    idleUntilNextTick({
      intervalMs: TICK_INTERVAL_MS,
      isShuttingDown: () => true,
      hasPendingIndexRequest: async () => {
        checks++;
        return false;
      },
      sleep: clock.sleep,
      now: clock.now,
    }),
  );

  assert.equal(clock.sleeps(), 0);
  assert.equal(checks, 0);
});
