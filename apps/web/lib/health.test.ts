import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { nativeToScVal, type Transaction } from '@stellar/stellar-sdk';
import type { SimulatingServer } from './server/registry-read.ts';
import {
  CHECK_TIMEOUT_MS,
  checkRegistry,
  collectHealth,
  overallStatus,
  type CheckStatus,
} from './health.ts';

// Structurally valid, never deployed: every test injects a stub server rather
// than reaching an RPC endpoint.
const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

function configureRegistry(): void {
  process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID = CONTRACT_ID;
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_IDENTITY_REGISTRY_ID;
});

/** Stub server answering a `count` simulation with `value`. */
function countingServer(value: number): SimulatingServer {
  return {
    async simulateTransaction() {
      return { result: { retval: nativeToScVal(value, { type: 'u32' }) } };
    },
  };
}

/** Stub server standing in for an unreachable RPC endpoint. */
function unreachableServer(): SimulatingServer {
  return {
    async simulateTransaction(): Promise<Transaction> {
      throw new Error('connect ECONNREFUSED');
    },
  };
}

/** Stub server that never answers — an RPC that accepts and then hangs. */
function hangingServer(): SimulatingServer {
  return {
    simulateTransaction() {
      return new Promise<never>(() => {});
    },
  };
}

const probe = (value: CheckStatus) => async () => value;

// ── registry check ────────────────────────────────────────────────────────

test('registry is skipped when no contract id is configured', async () => {
  // Not "up": a preview with no registry is not a healthy registry, it is a
  // deployment that does not have one.
  assert.equal(await checkRegistry(), 'skipped');
});

test('registry is up when the count view call answers', async () => {
  configureRegistry();
  assert.equal(await checkRegistry({ server: countingServer(7) }), 'up');
});

test('a registry with zero bindings is still up', async () => {
  configureRegistry();
  assert.equal(await checkRegistry({ server: countingServer(0) }), 'up');
});

test('registry is down when the RPC endpoint is unreachable', async () => {
  configureRegistry();
  assert.equal(await checkRegistry({ server: unreachableServer() }), 'down');
});

test('registry is down when the RPC hangs rather than hanging the probe', async () => {
  configureRegistry();
  const started = Date.now();
  assert.equal(await checkRegistry({ server: hangingServer() }), 'down');
  assert.ok(
    Date.now() - started < CHECK_TIMEOUT_MS * 2,
    'the check must time out rather than wait on the RPC',
  );
});

// ── report assembly ───────────────────────────────────────────────────────

test('a down registry degrades the probe even with the database up', async () => {
  // The regression this whole check exists for: the claim flow, /handles and
  // chain-backed profiles are all down, and the old probe said "ok".
  const report = await collectHealth({
    db: probe('up'),
    registry: probe('down'),
    nonceStore: async () => 'up',
    rateLimitStore: async () => 'up',
  });
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.checks, {
    db: 'up',
    registry: 'down',
    nonceStore: 'up',
    rateLimitStore: 'up',
  });
});

test('a down database still degrades the probe', async () => {
  const report = await collectHealth({ db: probe('down'), registry: probe('up') });
  assert.equal(report.status, 'degraded');
});

test('checks are reported separately so the failing dependency is identifiable', async () => {
  const report = await collectHealth({ db: probe('down'), registry: probe('down') });
  assert.equal(report.checks.db, 'down');
  assert.equal(report.checks.registry, 'down');
});

test('skipped dependencies do not degrade the probe', async () => {
  const report = await collectHealth({ db: probe('skipped'), registry: probe('skipped') });
  assert.equal(report.status, 'ok');
});

test('the report keeps its existing shape', async () => {
  const report = await collectHealth({ db: probe('up'), registry: probe('up') });
  assert.equal(report.status, 'ok');
  assert.equal(report.service, 'signet-web');
  assert.ok(Number.isFinite(Date.parse(report.ts)));
  assert.ok(Number.isFinite(report.uptimeSeconds));
});

test('checks run concurrently, so the probe is not the sum of its timeouts', async () => {
  const slow = (value: CheckStatus) => () =>
    new Promise<CheckStatus>((resolve) => setTimeout(() => resolve(value), 120));
  const started = Date.now();
  await collectHealth({ db: slow('up'), registry: slow('up') });
  assert.ok(Date.now() - started < 220, 'probes must not run serially');
});

const stores = { nonceStore: 'up', rateLimitStore: 'up' } as const;

test('overallStatus degrades on any down user-facing check', () => {
  assert.equal(overallStatus({ db: 'up', registry: 'up', ...stores }), 'ok');
  assert.equal(overallStatus({ db: 'skipped', registry: 'up', ...stores }), 'ok');
  assert.equal(overallStatus({ db: 'up', registry: 'down', ...stores }), 'degraded');
  assert.equal(overallStatus({ db: 'down', registry: 'skipped', ...stores }), 'degraded');
});

test('a down nonce store degrades the probe: it fails closed, so sign-in is broken', () => {
  assert.equal(
    overallStatus({ db: 'up', registry: 'up', nonceStore: 'down', rateLimitStore: 'up' }),
    'degraded',
  );
});

test('a down rate-limit store is reported but does not degrade: it fails open', () => {
  assert.equal(
    overallStatus({ db: 'up', registry: 'up', nonceStore: 'up', rateLimitStore: 'down' }),
    'ok',
  );
});

test('the per-instance memory fallback is visible without being an error', () => {
  assert.equal(
    overallStatus({ db: 'up', registry: 'up', nonceStore: 'memory', rateLimitStore: 'memory' }),
    'ok',
  );
});
