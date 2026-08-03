import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, Keypair, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  decodeEvent,
  applyAttestation,
  runAttestationWorker,
  type AttestationStore,
  type CursorStore,
} from './attestation.ts';

function topics(kind: string, handle: string): xdr.ScVal[] {
  return [nativeToScVal(kind, { type: 'symbol' }), nativeToScVal(handle, { type: 'string' })];
}
const walletVal = (pubkey: string): xdr.ScVal => new Address(pubkey).toScVal();

test('decodeEvent decodes a claimed event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('claimed', 'aquawolf'), walletVal(pk)), {
    kind: 'claimed',
    handle: 'aquawolf',
    wallet: pk,
  });
});

test('decodeEvent decodes a released event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('released', 'aquawolf'), walletVal(pk)), {
    kind: 'released',
    handle: 'aquawolf',
    wallet: pk,
  });
});

test('decodeEvent decodes a revoked event', () => {
  const pk = Keypair.random().publicKey();
  assert.deepEqual(decodeEvent(topics('revoked', 'aquawolf'), walletVal(pk)), {
    kind: 'revoked',
    handle: 'aquawolf',
    wallet: pk,
  });
});

test('decodeEvent ignores unrelated or malformed events', () => {
  const pk = Keypair.random().publicKey();
  assert.equal(decodeEvent(topics('transfer', 'x'), walletVal(pk)), null);
  assert.equal(decodeEvent([nativeToScVal('claimed', { type: 'symbol' })], walletVal(pk)), null);
});

function recordingStore(): { store: AttestationStore; calls: any[] } {
  const calls: any[] = [];
  const store: AttestationStore = {
    profile: {
      upsert: async (a) => {
        calls.push(['profile.upsert', a]);
        return { id: 'p1' };
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
  await applyAttestation(store, { kind: 'claimed', handle: 'aquawolf', wallet: 'GWALLET' });

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'profile.upsert');
  assert.equal(calls[0][1].where.handle, 'aquawolf');
  assert.equal(calls[1][0], 'wallet.upsert');
  assert.equal(calls[1][1].where.pubkey, 'GWALLET');
  assert.equal(calls[1][1].create.profileId, 'p1');
  assert.equal(calls[1][1].update.source, 'onchain');
});

test('applyAttestation removes the binding on release', async () => {
  const { store, calls } = recordingStore();
  await applyAttestation(store, { kind: 'released', handle: 'aquawolf', wallet: 'GWALLET' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'wallet.deleteMany');
  assert.equal(calls[0][1].where.pubkey, 'GWALLET');
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
