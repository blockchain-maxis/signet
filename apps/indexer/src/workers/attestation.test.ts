import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, Keypair, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  decodeEvent,
  applyAttestation,
  reconcileAgainstChain,
  runAttestationWorker,
  type AttestationStore,
  type CursorStore,
} from './attestation.ts';
import type { RegistryReader } from '../registry-read.ts';
import type { WalletSource } from '@signet/types';

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

test('decodeEvent decodes a transferred event', () => {
  const oldOwner = Keypair.random().publicKey();
  const newOwner = Keypair.random().publicKey();
  const value = xdr.ScVal.scvVec([
    new Address(oldOwner).toScVal(),
    new Address(newOwner).toScVal(),
  ]);

  assert.deepEqual(decodeEvent(topics('transferred', 'aquawolf'), value), {
    kind: 'transferred',
    handle: 'aquawolf',
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

test('applyAttestation moves the binding on transfer', async () => {
  const { store, calls } = recordingStore();
  await applyAttestation(store, {
    kind: 'transferred',
    handle: 'aquawolf',
    wallet: 'GNEW',
    from: 'GOLD',
  });

  // The handle's profile is upserted first, so a transfer still lands when the
  // indexer never saw the claim that created it.
  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'profile.upsert');
  assert.equal(calls[0][1].where.handle, 'aquawolf');
  assert.equal(calls[1][0], 'wallet.deleteMany');
  assert.equal(calls[1][1].where.pubkey, 'GOLD');
  assert.equal(calls[2][0], 'wallet.upsert');
  assert.equal(calls[2][1].where.pubkey, 'GNEW');
  assert.equal(calls[2][1].create.profileId, 'p1');
});

test('claim then transfer sequence leaves the new wallet as the final owner', async () => {
  const { store, calls } = recordingStore();

  await applyAttestation(store, { kind: 'claimed', handle: 'aquawolf', wallet: 'GOLD' });
  await applyAttestation(store, {
    kind: 'transferred',
    handle: 'aquawolf',
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
    { handle: 'aquawolf', wallets: [{ pubkey: 'GCURATED', source: 'curated' }] },
  ]);
  const { reader } = fakeReader({ alice: pk, aquawolf: null });

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
  // …the curated demo wallet was left alone…
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
