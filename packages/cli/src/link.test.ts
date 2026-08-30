import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkClient, type DevicePair } from './link-client.ts';
import { formatRemaining, formatTtlLabel, linkCommand, type LinkCommandDeps } from './link.ts';
import type { WaitResult } from './wait-for-approval.ts';

const PAIR: DevicePair = {
  pairingCode: 'AB12CD34',
  verificationUrl: 'http://localhost:3000/link/AB12CD34',
  ttlMs: 5 * 60_000,
  intervalMs: 2000,
};

function fakeLinkClient(pair = PAIR): LinkClient {
  const fetchImpl = (async () =>
    ({ ok: true, status: 200, json: async () => pair }) as Response) as unknown as typeof fetch;
  return new LinkClient('http://localhost:3000', { fetch: fetchImpl });
}

function buildDeps(opts: { outcome: WaitResult['outcome'] }): { deps: LinkCommandDeps; lines: string[] } {
  const lines: string[] = [];
  const deps: LinkCommandDeps = {
    client: fakeLinkClient(),
    log: (line) => lines.push(line),
    openUrl: () => {},
    wait: async (): Promise<WaitResult> => ({ outcome: opts.outcome }),
  };
  return { deps, lines };
}

test('signet link announces what it is waiting for before it waits', async () => {
  const { deps, lines } = buildDeps({ outcome: 'approved' });
  const code = await linkCommand(deps);
  assert.equal(code, 0);
  const joined = lines.join('\n');
  assert.ok(joined.includes('waiting for you to approve'), 'says what it is waiting for');
  assert.ok(joined.includes('AB12CD34'), 'prints the pairing code');
  assert.ok(joined.includes('http://localhost:3000/link/AB12CD34'), 'prints the approval URL');
  assert.ok(joined.includes('5 minutes'), 'prints the bounded wait duration');
});

test('successful approval exits 0 and reads as success', async () => {
  const { deps, lines } = buildDeps({ outcome: 'approved' });
  const code = await linkCommand(deps);
  assert.equal(code, 0);
  assert.ok(lines.some((l) => l.includes('✓ Linked!')));
});

test('on timeout it exits non-zero and prints how to retry with the manual URL', async () => {
  const { deps, lines } = buildDeps({ outcome: 'timeout' });
  const code = await linkCommand(deps);
  assert.equal(code, 1);
  const joined = lines.join('\n');
  assert.ok(joined.includes('No approval received'), 'explains the bare-terminal case');
  assert.ok(joined.includes('signet link --api'), 'tells the developer how to re-run');
  assert.ok(joined.includes('http://localhost:3000/link/AB12CD34'), 'includes the manual URL');
  assert.ok(joined.includes('5 minutes'), 'ties the wait to the pairing TTL');
});

test('an expired pair also points back at the manual URL', async () => {
  const { deps, lines } = buildDeps({ outcome: 'expired' });
  const code = await linkCommand(deps);
  assert.equal(code, 1);
  const joined = lines.join('\n');
  assert.ok(joined.includes('expired'), 'names the condition');
  assert.ok(joined.includes('http://localhost:3000/link/AB12CD34'), 'prints the manual URL');
});

test('a rejected approval fails with a clear message', async () => {
  const { deps, lines } = buildDeps({ outcome: 'rejected' });
  const code = await linkCommand(deps);
  assert.equal(code, 1);
  assert.ok(lines.some((l) => l.includes('rejected')));
});

test('an unreachable link server fails fast with retry instructions, not a hang', async () => {
  const lines: string[] = [];
  const failing = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const client = new LinkClient('http://localhost:3999', { fetch: failing });
  // The wait is never reached (createDevice throws first); passing a real one
  // would touch real timers, so pass a stub that would fail the test if used.
  const never = () => new Promise<WaitResult>(() => {});
  const code = await linkCommand({ client, log: (l) => lines.push(l), openUrl: () => {}, wait: never });
  assert.equal(code, 1);
  const joined = lines.join('\n');
  assert.ok(joined.includes('Could not start a linking session'));
  assert.ok(joined.includes('signet link --api http://localhost:3999'));
});

test('formatRemaining renders a clock-style countdown', () => {
  assert.equal(formatRemaining(5 * 60_000), '5:00');
  assert.equal(formatRemaining(90_000), '1:30');
  assert.equal(formatRemaining(0), '0:00');
  assert.equal(formatRemaining(-5_000), '0:00');
});

test('formatTtlLabel humanizes the pairing TTL', () => {
  assert.equal(formatTtlLabel(5 * 60_000), '5 minutes (05:00)');
  assert.equal(formatTtlLabel(60_000), '1 minute (01:00)');
});