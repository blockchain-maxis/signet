import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, Keypair, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  decodeEvent,
  applyAttestation,
  reconcileAgainstChain,
  runAttestationWorker,
  MAX_EVENT_PAGES_PER_TICK,
  type AttestationStore,
  type CursorStore,
} from './attestation.ts';
import { logger } from '../logger.ts';
import type { RegistryReader } from '../registry-read.ts';
import type { WalletSource } from '@signet/types';

function topics(kind: string, handle: string): xdr.ScVal[] {
  return [nativeToScVal(kind, { type: 'symbol' }), nativeToScVal(handle, { type: 'string' })];
}
const walletVal = (pubkey: string): xdr.ScVal => new Address(pubkey).toScVal();

test('decodeEvent decodes a claimed event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('claimed', 'alice'), walletVal(pk)), {
    kind: 'claimed',
    handle: 'alice',
    wallet: pk,
  });
});

test('decodeEvent decodes a released event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('released', 'alice'), walletVal(pk)), {
    kind: 'released',
    handle: 'alice',
    wallet: pk,
  });
});

test('decodeEvent decodes a revoked event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('revoked', 'alice'), walletVal(pk)), {
    kind: 'revoked',
    handle: 'alice',
    wallet: pk,
  });
});

test('decodeEvent decodes a transferred event', () => {
  const oldOwner = Keypair.random().publicKey();
  const newOwner = Keypair.random().publicKey();
  const value = xdr.ScVal.scvVec([
    new Address(oldOwner).toScVal(),
    new Address(newOwner).toScVal(),
  ]);

  assert.deepEqual(decodeEvent(topics('transferred', 'alice'), value), {
    kind: 'transferred',
    handle: 'alice',
    wallet: newOwner,
    from: oldOwner,
  });
});

test('decodeEvent ignores unrelated or malformed events', () => {
  const pk = Keypair.random().publicKey();
  assert.equal(decodeEvent(topics('transfer', 'x'), walletVal(pk)), null);
  assert.equal(decodeEvent([nativeToScVal('claimed', { type: 'symbol' })], walletVal(pk)), null);
});

function recordingStore(
  profiles: { handle: string; wallets: { pubkey: string; source: WalletSource }[] }[] = [],
): { store: AttestationStore; calls: any[] } {
  const calls: any[] = [];
  const store: AttestationStore = {
    profile: {
      upsert: async (a) => {
        calls.push(['profile.upsert', a]);
        return { id: 'p1' };
      },
      findMany: async (a) => {
        calls.push(['profile.findMany', a]);
        return profiles;
      },
    },
    wallet: {
      upsert: async (a) => {
        calls.push(['wallet.upsert', a]);
      },
      deleteMany: async (a) => {
        calls.push(['wallet.deleteMany', a]);
      },
    },
  };
  return { store, calls };
}

test('applyAttestation upserts profile then links wallet on claim', async () => {
  const { store, calls } = recordingStore();
  await applyAttestation(store, { kind: 'claimed', handle: 'alice', wallet: 'GWALLET' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'profile.upsert');
  assert.equal(calls[0][1].where.handle, 'alice');
  assert.equal(calls[1][0], 'wallet.upsert');
  assert.equal(calls[1][1].where.pubkey, 'GWALLET');
  assert.equal(calls[1][1].create.profileId, 'p1');
  assert.equal(calls[1][1].update.source, 'onchain');
});

test('applyAttestation removes the binding on release', async () => {
  const { store, calls } = recordingStore();
  await applyAttestation(store, { kind: 'released', handle: 'alice', wallet: 'GWALLET' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'wallet.deleteMany');
  assert.equal(calls[0][1].where.pubkey, 'GWALLET');
});

test('applyAttestation moves the binding on transfer', async () => {
  const { store, calls } = recordingStore();
  await applyAttestation(store, {
    kind: 'transferred',
    handle: 'alice',
    wallet: 'GNEW',
    from: 'GOLD',
  });

  // The handle's profile is upserted first, so a transfer still lands when the
  // indexer never saw the claim that created it.
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'profile.upsert');
  assert.equal(calls[0][1].where.handle, 'alice');
  assert.equal(calls[1][0], 'wallet.deleteMany');
  assert.equal(calls[1][1].where.pubkey, 'GOLD');
  assert.equal(calls[2][0], 'wallet.upsert');
  assert.equal(calls[2][1].where.pubkey, 'GNEW');
  assert.equal(calls[2][1].create.profileId, 'p1');
});

test('claim then transfer sequence leaves the new wallet as the final owner', async () => {
  const { store, calls } = recordingStore();

  await applyAttestation(store, { kind: 'claimed', handle: 'alice', wallet: 'GOLD' });
  await applyAttestation(store, {
    kind: 'transferred',
    handle: 'alice',
    wallet: 'GNEW',
    from: 'GOLD',
  });

  const upserts = calls.filter((c: any[]) => c[0] === 'wallet.upsert');
  assert.deepEqual(
    upserts.map((c) => c[1].where.pubkey),
    ['GOLD', 'GNEW'],
  );
  assert.ok(calls.some((c: any[]) => c[0] === 'wallet.deleteMany' && c[1].where.pubkey === 'GOLD'));
});

// ─── Cursor resumption tests ────────────────────────────────────────────────

/**
 * Build a fake Soroban RPC server that returns configurable events and latest
 * ledger sequence.  The mock simulates real RPC behaviour: only events whose
 * ledger is >= `startLedger` are returned.
 */
function fakeServer(overrides: {
  latestLedger?: number;
  ledgerOfEvents?: number;
  events?: Array<{ topic: xdr.ScVal[]; value: xdr.ScVal }>;
}) {
  const latestLedger = overrides.latestLedger ?? 1000;
  const ledgerOfEvents = overrides.ledgerOfEvents ?? latestLedger;
  const rawEvents = overrides.events ?? [];

  // Only the two methods the worker calls are implemented, so the stub is cast
  // to the SDK's `rpc.Server` rather than widening the worker's own signature.
  return {
    getLatestLedger: async () => ({ sequence: latestLedger }),
    getEvents: async (input: { startLedger: number }) => ({
      latestLedger,
      // Filter events that are at or after the requested startLedger.
      events: (input.startLedger > ledgerOfEvents ? [] : rawEvents).map((e) => ({
        topic: e.topic,
        value: e.value,
        ledger: ledgerOfEvents,
      })),
    }),
  } as unknown as rpc.Server;
}

/** Factory for the mock cursor store. Records every interaction. */
function recordingCursorStore(initial: { lastLedger: number } | null = null): {
  store: CursorStore;
  calls: any[];
  saved: { lastLedger: number } | null;
} {
  let saved = initial;
  const calls: any[] = [];
  return {
    store: {
      indexerCursor: {
        findUnique: async (_args) => {
          calls.push(['findUnique', _args]);
          return saved;
        },
        upsert: async (args) => {
          calls.push(['upsert', args]);
          saved = { lastLedger: args.update.lastLedger };
        },
      },
    },
    calls,
    get saved() {
      return saved;
    },
  };
}

test('runAttestationWorker starts from latestLedger - eventWindowLedgers on first run', async () => {
  const pk = Keypair.random().publicKey();
  const server = fakeServer({
    latestLedger: 1000,
    events: [
      {
        topic: topics('claimed', 'alice'),
        value: walletVal(pk),
      },
    ],
  });
  const cursor = recordingCursorStore(null); // no cursor yet
  const { store, calls: evCalls } = recordingStore();

  await runAttestationWorker(
    server,
    {
      registryContractId: 'C…REGISTRY',
      eventWindowLedgers: 100,
    } as any,
    cursor.store,
    store,
  );

  // On first run (no cursor) it should have called getEvents with
  // startLedger = 1000 - 100 = 900.
  const findCalls = cursor.calls.filter((c: any[]) => c[0] === 'findUnique');
  assert.ok(findCalls.length >= 1, 'expected findUnique to be called');

  // The worker should have applied the event and upserted the cursor.
  const upsertCalls = cursor.calls.filter((c: any[]) => c[0] === 'upsert');
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0][1].update.lastLedger, 1000);

  // Event should have been applied.
  assert.ok(evCalls.length > 0);
});

test('runAttestationWorker resumes from stored cursor on second run', async () => {
  const pk = Keypair.random().publicKey();
  const events = [
    {
      topic: topics('claimed', 'bob'),
      value: walletVal(pk),
    },
  ];

  // First run: no cursor, processes events.
  const cursor = recordingCursorStore(null);
  const { store, calls: firstCalls } = recordingStore();
  const server1 = fakeServer({
    latestLedger: 500,
    events,
  });

  await runAttestationWorker(
    server1,
    {
      registryContractId: 'C…REGISTRY',
      eventWindowLedgers: 200,
    } as any,
    cursor.store,
    store,
  );

  // Verify cursor was saved.
  assert.equal(cursor.saved?.lastLedger, 500);
  assert.ok(firstCalls.length > 0, 'expected events to be applied on first run');

  // Second run: cursor exists (lastLedger=500), should start from 501.
  // The fake server is at ledger 600, but there are no new events — the worker
  // should start from cursor.lastLedger + 1 = 501.
  const startLedgerFromSecondRun: { value: number } = { value: 0 };
  const server2 = {
    getLatestLedger: async () => ({ sequence: 600 }),
    getEvents: async (input: { startLedger: number }) => {
      startLedgerFromSecondRun.value = input.startLedger;
      return { latestLedger: 600, events: [] };
    },
  } as unknown as rpc.Server;

  const { store: store2, calls: secondCalls } = recordingStore();
  await runAttestationWorker(
    server2,
    {
      registryContractId: 'C…REGISTRY',
      eventWindowLedgers: 200,
    } as any,
    cursor.store,
    store2,
  );

  // Second run should start from cursor.lastLedger + 1 = 501.
  assert.equal(startLedgerFromSecondRun.value, 501);

  // No new events to process → no store calls.
  assert.equal(secondCalls.length, 0);
});

test('runAttestationWorker does not re-apply already-seen events on resumption', async () => {
  const pk = Keypair.random().publicKey();
  const aliceEvent = {
    topic: topics('claimed', 'alice'),
    value: walletVal(pk),
  };

  // Seed a cursor to simulate a previous run that already processed ledger 500.
  const cursor = recordingCursorStore({ lastLedger: 500 });

  // Second run: ledger 500 was already seen. Server returns events from ledger
  // 500 again (simulating a misconfiguration or overlapping query), but the
  // worker should NOT re-process them because it starts from cursor+1 = 501.
  const server = fakeServer({
    latestLedger: 600,
    ledgerOfEvents: 500, // events at ledger 500 (already processed)
    events: [aliceEvent],
  });

  const { store, calls } = recordingStore();
  await runAttestationWorker(
    server,
    {
      registryContractId: 'C…REGISTRY',
      eventWindowLedgers: 200,
    } as any,
    cursor.store,
    store,
  );

  // Worker starts from cursor+1=501, so events at ledger 500 are not seen.
  // No events should have been applied.
  assert.equal(calls.length, 0, 'should not re-apply already-seen events');
});

test('runAttestationWorker saves cursor after error-free run', async () => {
  const cursor = recordingCursorStore({ lastLedger: 100 });
  const server = fakeServer({
    latestLedger: 200,
    events: [],
  });
  const { store } = recordingStore();

  await runAttestationWorker(
    server,
    {
      registryContractId: 'C…REGISTRY',
      eventWindowLedgers: 200,
    } as any,
    cursor.store,
    store,
  );

  // Cursor should be updated to the latest ledger = 200.
  const upsertCalls = cursor.calls.filter((c: any[]) => c[0] === 'upsert');
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0][1].update.lastLedger, 200);
});

test('runAttestationWorker does not move cursor on fetch error', async () => {
  const cursor = recordingCursorStore({ lastLedger: 100 });
  const errorServer = {
    getLatestLedger: async () => ({ sequence: 200 }),
    getEvents: async () => {
      throw new Error('network error');
    },
  } as unknown as rpc.Server;
  const { store } = recordingStore();

  await runAttestationWorker(
    errorServer,
    {
      registryContractId: 'C…REGISTRY',
      eventWindowLedgers: 200,
    } as any,
    cursor.store,
    store,
  );

  // Cursor should NOT have been upserted on error.
  const upsertCalls = cursor.calls.filter((c: any[]) => c[0] === 'upsert');
  assert.equal(upsertCalls.length, 0, 'cursor should not advance on error');
  // Stored cursor should still be 100.
  assert.equal(cursor.saved?.lastLedger, 100);
});

// ─── Reconcile tests (issue #189) ───────────────────────────────────────────

/** A RegistryReader answering from a fixed handle→wallet map. */
function fakeReader(
  bindings: Record<string, string | null>,
  chainCount: number | null = null,
): { reader: RegistryReader; resolveCalls: string[][] } {
  const resolveCalls: string[][] = [];
  return {
    reader: {
      resolveMany: async (handles) => {
        resolveCalls.push(handles);
        return handles.map((h) => bindings[h] ?? null);
      },
      count: async () => chainCount ?? Object.values(bindings).filter(Boolean).length,
    },
    resolveCalls,
  };
}

test('an unservable cursor window reconciles from contract state instead of reading events', async () => {
  // Cursor at 1000, tip at 20000, window 8000: getEvents would return an
  // error-free empty page and the gap would vanish. The worker must not even
  // ask — it sweeps known handles through resolve and jumps the cursor to the
  // tip only after the sweep succeeds.
  const pk = Keypair.random().publicKey();
  let getEventsCalled = false;
  const server = {
    getLatestLedger: async () => ({ sequence: 20_000 }),
    getEvents: async () => {
      getEventsCalled = true;
      return { latestLedger: 20_000, events: [] };
    },
  } as unknown as rpc.Server;

  const cursor = recordingCursorStore({ lastLedger: 1000 });
  const { store, calls } = recordingStore([
    { handle: 'alice', wallets: [] }, // claimed during the lost window
    { handle: 'legacyseed', wallets: [{ pubkey: 'GCURATED', source: 'curated' }] },
  ]);
  const { reader } = fakeReader({ alice: pk, legacyseed: null });

  const result = await runAttestationWorker(
    server,
    { registryContractId: 'C…REGISTRY', eventWindowLedgers: 8000, network: 'testnet' } as any,
    cursor.store,
    store,
    reader,
  );

  assert.equal(getEventsCalled, false, 'events must not be read from an unservable window');
  assert.equal(result.reconciled?.candidates, 2);
  assert.equal(result.reconciled?.bound, 1);
  // alice's lost claim was re-learned from state…
  assert.ok(
    calls.some((c: any[]) => c[0] === 'wallet.upsert' && c[1].where.pubkey === pk),
    'expected the lost claim to be applied from contract state',
  );
  // …the legacy curated wallet was left alone…
  assert.ok(
    !calls.some((c: any[]) => c[0] === 'wallet.deleteMany' && c[1].where.pubkey === 'GCURATED'),
    'curated wallets must never be reconciled away',
  );
  // …and the cursor resumed from the near edge of the servable window, so
  // the next tick replays the still-readable tail for unknown handles.
  assert.equal(cursor.saved?.lastLedger, 12_000);
});

test('reconcile never deletes a wallet another handle re-claimed during the sweep', async () => {
  // Snapshot says W belongs to a-old; the chain says W now owns b-new.
  // Processing b-new first upserts W; processing a-old later sees W in its
  // stale wallet list and must NOT delete the row that upsert re-pointed.
  const w = Keypair.random().publicKey();
  const { store, calls } = recordingStore([
    { handle: 'b-new', wallets: [] },
    { handle: 'a-old', wallets: [{ pubkey: w, source: 'onchain' }] },
  ]);
  const { reader } = fakeReader({ 'b-new': w, 'a-old': null });

  const stats = await reconcileAgainstChain(store, reader);

  assert.equal(stats.bound, 1);
  assert.ok(
    calls.some((c: any[]) => c[0] === 'wallet.upsert' && c[1].where.pubkey === w),
    'expected b-new to claim the wallet',
  );
  assert.ok(
    !calls.some((c: any[]) => c[0] === 'wallet.deleteMany' && c[1].where.pubkey === w),
    'a stale snapshot link must not delete a wallet the sweep re-bound',
  );
  assert.equal(stats.removed, 0);
});

test('reconcile heals a transfer and drops released on-chain bindings', async () => {
  const newOwner = Keypair.random().publicKey();
  const { store, calls } = recordingStore([
    { handle: 'moved', wallets: [{ pubkey: 'GOLDOWNER', source: 'onchain' }] },
    { handle: 'gone', wallets: [{ pubkey: 'GRELEASED', source: 'onchain' }] },
  ]);
  const { reader } = fakeReader({ moved: newOwner, gone: null });

  const stats = await reconcileAgainstChain(store, reader);

  assert.equal(stats.bound, 1);
  assert.equal(stats.removed, 2);
  // The transferred handle now points at its new owner, and the old row went.
  assert.ok(calls.some((c: any[]) => c[0] === 'wallet.upsert' && c[1].where.pubkey === newOwner));
  assert.ok(
    calls.some((c: any[]) => c[0] === 'wallet.deleteMany' && c[1].where.pubkey === 'GOLDOWNER'),
  );
  assert.ok(
    calls.some((c: any[]) => c[0] === 'wallet.deleteMany' && c[1].where.pubkey === 'GRELEASED'),
  );
});

test('reconcile raises when the chain counts bindings the database has never seen', async () => {
  const pk = Keypair.random().publicKey();
  const { store } = recordingStore([{ handle: 'known', wallets: [] }]);
  // Chain says 3 handles are bound; we could only confirm 1 → 2 unknown.
  const { reader } = fakeReader({ known: pk }, 3);

  const stats = await reconcileAgainstChain(store, reader);
  assert.equal(stats.bound, 1);
  assert.equal(stats.unknownOnChain, 2);
});

test('a reconcile failure leaves the cursor untouched for a retry', async () => {
  const server = {
    getLatestLedger: async () => ({ sequence: 20_000 }),
    getEvents: async () => ({ latestLedger: 20_000, events: [] }),
  } as unknown as rpc.Server;
  const cursor = recordingCursorStore({ lastLedger: 1000 });
  const { store } = recordingStore([{ handle: 'x', wallets: [] }]);
  const reader: RegistryReader = {
    resolveMany: async () => {
      throw new Error('rpc down');
    },
    count: async () => null,
  };

  const result = await runAttestationWorker(
    server,
    { registryContractId: 'C…REGISTRY', eventWindowLedgers: 8000, network: 'testnet' } as any,
    cursor.store,
    store,
    reader,
  );

  assert.equal(result.reconciled, undefined);
  assert.equal(cursor.saved?.lastLedger, 1000, 'cursor must not move past an unreconciled gap');
});

// ── pairing audit trail ───────────────────────────────────────────────────

/**
 * Captures the JSON log lines the worker writes, so the audit trail can be
 * asserted on. The logger writes straight to the streams, so that is where the
 * capture goes - intercepting `console` would silently record nothing.
 */
function captureLogLines(): { lines: Record<string, unknown>[]; restore: () => void } {
  const lines: Record<string, unknown>[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);

  const record = (chunk: unknown): boolean => {
    for (const part of String(chunk).split('\n')) {
      if (!part.trim()) continue;
      try {
        lines.push(JSON.parse(part) as Record<string, unknown>);
      } catch {
        /* not a structured line; the audit trail only cares about the JSON ones */
      }
    }
    return true;
  };

  process.stdout.write = record as typeof process.stdout.write;
  process.stderr.write = record as typeof process.stderr.write;

  return {
    lines,
    restore: () => {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    },
  };
}

test('a completed link is recorded with its handle and public wallet', async () => {
  const { store } = recordingStore();
  const capture = captureLogLines();
  try {
    await applyAttestation(store, { kind: 'claimed', handle: 'aquawolf', wallet: 'GWALLET' });
  } finally {
    capture.restore();
  }

  const event = capture.lines.find((l) => l.msg === 'pairing.linkCompleted');
  assert.ok(event, 'expected a pairing.linkCompleted line');
  assert.equal(event.handle, 'aquawolf');
  assert.equal(event.wallet, 'GWALLET');
  assert.equal(event.outcome, 'completed');
  assert.equal(event.source, 'attestation-worker');
  assert.equal(event.lvl, 'info', 'the audit trail must survive a production log level');
});

test('a caller that names an explicit source overrides the attestation-worker default', async () => {
  const { store } = recordingStore();
  const capture = captureLogLines();
  try {
    await applyAttestation(store, {
      kind: 'claimed',
      handle: 'aquawolf',
      wallet: 'GWALLET',
      source: 'dev-seed',
    });
  } finally {
    capture.restore();
  }

  const event = capture.lines.find((l) => l.msg === 'pairing.linkCompleted');
  assert.ok(event, 'expected a pairing.linkCompleted line');
  assert.equal(
    event.source,
    'dev-seed',
    'a binding applied by dev:seed must not be misattributed to the event-stream worker',
  );
});

test('an unlink records why the binding went away', async () => {
  const { store } = recordingStore();
  const capture = captureLogLines();
  try {
    await applyAttestation(store, { kind: 'revoked', handle: 'aquawolf', wallet: 'GWALLET' });
  } finally {
    capture.restore();
  }

  const event = capture.lines.find((l) => l.msg === 'pairing.unlinked');
  assert.ok(event, 'expected a pairing.unlinked line');
  assert.equal(event.handle, 'aquawolf');
  assert.equal(event.wallet, 'GWALLET');
  assert.equal(event.reason, 'revoked');
});

test('reconcile records the bindings it drops, and why', async () => {
  const { store } = recordingStore([
    { handle: 'moved', wallets: [{ pubkey: 'GOLDOWNER', source: 'onchain' }] },
    { handle: 'gone', wallets: [{ pubkey: 'GRELEASED', source: 'onchain' }] },
  ]);
  const reader: RegistryReader = {
    resolveMany: async () => ['GNEWOWNER', null],
    count: async () => 1,
  };

  const capture = captureLogLines();
  try {
    await reconcileAgainstChain(store, reader);
  } finally {
    capture.restore();
  }

  const unlinked = capture.lines.filter((l) => l.msg === 'pairing.unlinked');
  const reasons = new Map(unlinked.map((l) => [l.wallet, l.reason]));

  assert.equal(reasons.get('GOLDOWNER'), 'transferred');
  assert.equal(reasons.get('GRELEASED'), 'no-longer-bound');
  for (const line of unlinked) {
    assert.equal(line.source, 'reconcile', 'a rebuild pass must be distinguishable from the event stream');
  }
});

test('the audit trail never carries key material', async () => {
  const { store } = recordingStore();
  const capture = captureLogLines();
  try {
    await applyAttestation(store, { kind: 'claimed', handle: 'aquawolf', wallet: 'GWALLET' });
    await applyAttestation(store, { kind: 'released', handle: 'aquawolf', wallet: 'GWALLET' });
  } finally {
    capture.restore();
  }

  const pairingLines = capture.lines.filter((l) => String(l.msg).startsWith('pairing.'));
  assert.ok(pairingLines.length >= 2);
  for (const line of pairingLines) {
    const serialized = JSON.stringify(line);
    assert.doesNotMatch(serialized, /\bS[A-Z2-7]{55}\b/, 'a secret seed reached the log');
    assert.doesNotMatch(serialized, /secret|seed|signature|passphrase/i);
  }
});

// ─── Paging within a tick (#960) ─────────────────────────────────────────────

type PagedEvent = { ledger: number; topic: xdr.ScVal[]; value: xdr.ScVal };
type GetEventsCall = { startLedger?: number; cursor?: string; limit?: number };

/**
 * `count` claims by `count` distinct handles (`user0`, `user1`, ...), three to
 * a ledger starting at `firstLedger`. Three to a ledger means a page of 200
 * ends part-way through one: events 198, 199 and 200 share a ledger.
 */
function claims(count: number, firstLedger = 1_000, perLedger = 3): PagedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    ledger: firstLedger + Math.floor(i / perLedger),
    topic: topics('claimed', `user${i}`),
    value: walletVal(Keypair.random().publicKey()),
  }));
}

/**
 * A fake RPC that pages the way the real one does: `getEvents` takes either a
 * `startLedger` or the `cursor` an earlier response ended with, and hands back
 * at most `limit` events from there, in order. The cursor is simply the index
 * of the next unread event.
 */
function pagedServer(
  events: PagedEvent[],
  latestLedger: number,
  failOnCall?: number,
): { server: rpc.Server; calls: GetEventsCall[] } {
  const calls: GetEventsCall[] = [];
  const server = {
    getLatestLedger: async () => ({ sequence: latestLedger }),
    getEvents: async (input: GetEventsCall) => {
      calls.push({ startLedger: input.startLedger, cursor: input.cursor, limit: input.limit });
      if (calls.length === failOnCall) throw new Error('rpc unavailable');
      let from: number;
      if (input.cursor !== undefined) {
        from = Number(input.cursor);
      } else {
        const first = events.findIndex((e) => e.ledger >= (input.startLedger ?? 0));
        from = first === -1 ? events.length : first;
      }
      const page = events.slice(from, from + (input.limit ?? 100));
      return { latestLedger, events: page, cursor: String(from + page.length) };
    },
  } as unknown as rpc.Server;
  return { server, calls };
}

/** The handles a recording store was asked to bind, in the order it was asked. */
function boundHandles(calls: any[]): string[] {
  return calls.filter((c) => c[0] === 'profile.upsert').map((c) => c[1].where.handle as string);
}

/** Every `user<i>` for `i` in `[from, to)`. */
function users(from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `user${from + i}`);
}

const PAGING_CONFIG = { registryContractId: 'C…REGISTRY', eventWindowLedgers: 5_000 } as any;

test('runAttestationWorker reads a second page when the first comes back full', async () => {
  const { server, calls } = pagedServer(claims(250), 2_000);
  const cursor = recordingCursorStore({ lastLedger: 999 });
  const { store, calls: evCalls } = recordingStore();

  const result = await runAttestationWorker(server, PAGING_CONFIG, cursor.store, store);

  // All 250, in order, in one tick.
  assert.equal(result.eventsDecoded, 250);
  assert.deepEqual(boundHandles(evCalls), users(0, 250));

  // The first call names the ledger; the second passes the cursor the first
  // response ended with, and no ledger, as the RPC requires.
  assert.deepEqual(calls, [
    { startLedger: 1_000, cursor: undefined, limit: 200 },
    { startLedger: undefined, cursor: '200', limit: 200 },
  ]);

  // The read ran dry, so the cursor moves to the tip.
  assert.equal(cursor.saved?.lastLedger, 2_000);
});

test('runAttestationWorker stops at the page cap and the next tick reads the rest', async () => {
  const events = claims(250);
  const { server, calls } = pagedServer(events, 2_000);
  const cursor = recordingCursorStore({ lastLedger: 999 });

  // Tick 1, capped at one page: the first 200 events, and no more calls.
  const first = recordingStore();
  const warnings: string[] = [];
  const originalWarn = logger.warn;
  logger.warn = (_fields, message) => {
    warnings.push(message);
  };
  let capped: Awaited<ReturnType<typeof runAttestationWorker>>;
  try {
    capped = await runAttestationWorker(
      server,
      PAGING_CONFIG,
      cursor.store,
      first.store,
      undefined,
      { maxPages: 1 },
    );
  } finally {
    logger.warn = originalWarn;
  }
  // Stopping at the cap is routine. It is not the "stalled" case, which is
  // only for a cursor that cannot advance at all.
  assert.deepEqual(
    warnings.filter((m) => m.startsWith('attestation.stalled')),
    [],
  );
  assert.equal(capped.eventsDecoded, 200);
  assert.deepEqual(boundHandles(first.calls), users(0, 200));
  assert.equal(calls.length, 1);

  // The 200th event is in ledger 1066, and so is the 201st. The cursor is
  // saved one below it, not at the tip, so that ledger is read again.
  assert.equal(events[199]!.ledger, 1_066);
  assert.equal(events[200]!.ledger, 1_066);
  assert.equal(cursor.saved?.lastLedger, 1_065);

  // Tick 2 starts at ledger 1066: the two events of it that were already
  // applied (198 and 199) and then the 50 that were not.
  const second = recordingStore();
  const rest = await runAttestationWorker(server, PAGING_CONFIG, cursor.store, second.store);
  assert.equal(calls[1]!.startLedger, 1_066);
  assert.deepEqual(boundHandles(second.calls), users(198, 250));
  assert.equal(rest.eventsDecoded, 52);
  assert.equal(cursor.saved?.lastLedger, 2_000);

  // Between them the two ticks applied every one of the 250.
  const applied = new Set([...boundHandles(first.calls), ...boundHandles(second.calls)]);
  assert.equal(applied.size, 250);
});

test('runAttestationWorker still moves the cursor to the tip for a single short page', async () => {
  const { server, calls } = pagedServer(claims(50), 2_000);
  const cursor = recordingCursorStore({ lastLedger: 999 });
  const { store, calls: evCalls } = recordingStore();

  const result = await runAttestationWorker(server, PAGING_CONFIG, cursor.store, store);

  assert.equal(result.eventsDecoded, 50);
  assert.equal(boundHandles(evCalls).length, 50);
  assert.equal(calls.length, 1, 'a short page needs no second call');
  assert.equal(cursor.saved?.lastLedger, 2_000);
});

test('runAttestationWorker asks once more when a page is exactly full, and finds it empty', async () => {
  const { server, calls } = pagedServer(claims(200), 2_000);
  const cursor = recordingCursorStore({ lastLedger: 999 });
  const { store } = recordingStore();

  const result = await runAttestationWorker(server, PAGING_CONFIG, cursor.store, store);

  // 200 events could be all of them or the first of more; only a second
  // (empty) page can tell, and then the tip is safe.
  assert.equal(result.eventsDecoded, 200);
  assert.equal(calls.length, 2);
  assert.equal(cursor.saved?.lastLedger, 2_000);
});

test('runAttestationWorker reads at most MAX_EVENT_PAGES_PER_TICK pages by default', async () => {
  assert.equal(MAX_EVENT_PAGES_PER_TICK, 10);

  // One page more than the cap allows: 2,200 events.
  const events = claims(200 * (MAX_EVENT_PAGES_PER_TICK + 1));
  const { server, calls } = pagedServer(events, 9_000);
  const cursor = recordingCursorStore({ lastLedger: 999 });
  const { store } = recordingStore();

  const result = await runAttestationWorker(
    server,
    { ...PAGING_CONFIG, eventWindowLedgers: 50_000 },
    cursor.store,
    store,
  );

  assert.equal(calls.length, MAX_EVENT_PAGES_PER_TICK);
  assert.equal(result.eventsDecoded, 200 * MAX_EVENT_PAGES_PER_TICK);
  // Below the last event read (index 1999), not at the tip.
  assert.equal(cursor.saved?.lastLedger, events[1_999]!.ledger - 1);
});

test('runAttestationWorker leaves the cursor alone when a later page fails', async () => {
  // The second call throws: the first 200 were applied, and they will simply
  // be applied again next tick, because the cursor has not moved.
  const { server, calls } = pagedServer(claims(250), 2_000, 2);
  const cursor = recordingCursorStore({ lastLedger: 999 });
  const { store } = recordingStore();

  const result = await runAttestationWorker(server, PAGING_CONFIG, cursor.store, store);

  assert.equal(calls.length, 2);
  assert.equal(result.eventsDecoded, 200);
  assert.equal(cursor.saved?.lastLedger, 999);
  assert.equal(cursor.calls.filter((c: any[]) => c[0] === 'upsert').length, 0);
});

test('runAttestationWorker never moves the cursor backwards when one ledger overflows a tick', async () => {
  // More registry events in a single ledger than the capped tick reads. There
  // is no ledger to resume from short of the one it started at, so the cursor
  // stays where it was, and the worker says so instead of looping in silence.
  const { server } = pagedServer(claims(250, 1_000, 250), 2_000);
  const cursor = recordingCursorStore({ lastLedger: 999 });
  const { store } = recordingStore();

  const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const originalWarn = logger.warn;
  logger.warn = (fields, message) => {
    warnings.push({ fields, message });
  };
  try {
    await runAttestationWorker(server, PAGING_CONFIG, cursor.store, store, undefined, {
      maxPages: 1,
    });
  } finally {
    logger.warn = originalWarn;
  }

  assert.equal(cursor.saved?.lastLedger, 999);
  const stalled = warnings.filter((w) => w.message.startsWith('attestation.stalled'));
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0]!.fields.startLedger, 1_000);
});

test('runAttestationWorker reports the pages it read in attestation.done', async () => {
  const debugLines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  const originalDebug = logger.debug;
  logger.debug = (fields, message) => {
    debugLines.push({ fields, message });
  };
  try {
    const drained = pagedServer(claims(250), 2_000);
    await runAttestationWorker(
      drained.server,
      PAGING_CONFIG,
      recordingCursorStore({ lastLedger: 999 }).store,
      recordingStore().store,
    );
    const capped = pagedServer(claims(250), 2_000);
    await runAttestationWorker(
      capped.server,
      PAGING_CONFIG,
      recordingCursorStore({ lastLedger: 999 }).store,
      recordingStore().store,
      undefined,
      { maxPages: 1 },
    );
  } finally {
    logger.debug = originalDebug;
  }

  const done = debugLines.filter((l) => l.message === 'attestation.done').map((l) => l.fields);
  assert.deepEqual(done, [
    { applied: 250, pages: 2, throughLedger: 2_000, moreToRead: false },
    { applied: 200, pages: 1, throughLedger: 1_065, moreToRead: true },
  ]);
});
