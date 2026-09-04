import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeToScVal,
  scValToNative,
  type Operation,
  type Transaction,
} from '@stellar/stellar-sdk';
import {
  decodeEvent,
  reduceBindings,
  listDirectory,
  fetchIndexedDirectory,
  isRegistryConfigured,
  type DirectoryStore,
} from './directory.ts';
import type { SimulatingServer } from './server/registry-read.ts';

// Structurally valid, never deployed — every test injects a stub server rather
// than reaching an RPC endpoint.
const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const WALLET = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';

/**
 * A stub registry: answers `resolve(handle)` from `bound` and `count()` with
 * `count`, so a test can describe exactly which handles the chain considers
 * bound and check that nothing else is presented as one.
 */
function registryStub(bound: Record<string, string>, count: number): SimulatingServer {
  return {
    async simulateTransaction(tx: Transaction) {
      const op = tx.operations[0] as Operation.InvokeHostFunction;
      const invoke = op.func.invokeContract();
      const fn = invoke.functionName().toString();

      if (fn === 'count') {
        return { result: { retval: nativeToScVal(count, { type: 'u32' }) } };
      }
      if (fn === 'resolve') {
        const handle = scValToNative(invoke.args()[0]!) as string;
        const wallet = bound[handle];
        return {
          result: {
            retval: wallet ? nativeToScVal(wallet, { type: 'address' }) : nativeToScVal(null),
          },
        };
      }
      return { result: { retval: nativeToScVal(null) } };
    },
  };
}

test('reduceBindings keeps only the currently-bound handles', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'sorobuilder', wallet: 'GBBB' },
    { kind: 'released' as const, handle: 'aquawolf', wallet: 'GAAA' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(
    bound.map((e) => e.handle),
    ['sorobuilder'],
  );
});

test('decodeEvent accepts a revoked event (not just claimed/released)', () => {
  const topics = [
    nativeToScVal('revoked', { type: 'symbol' }),
    nativeToScVal('aquawolf', { type: 'string' }),
  ];
  const value = nativeToScVal(WALLET, { type: 'address' });
  assert.deepEqual(decodeEvent(topics, value), {
    kind: 'revoked',
    handle: 'aquawolf',
    wallet: WALLET,
  });
});

test('decodeEvent ignores an unrelated topic', () => {
  // Deliberately not `transferred`: that became a handled topic in #323, so
  // using it here would assert the opposite of what this test's name says —
  // it would only pass because the payload shape happens not to match.
  const topics = [
    nativeToScVal('bumped', { type: 'symbol' }),
    nativeToScVal('aquawolf', { type: 'string' }),
  ];
  const value = nativeToScVal(WALLET, { type: 'address' });
  assert.equal(decodeEvent(topics, value), null);
});

test('reduceBindings drops a handle on revoke, exactly as on release', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'sorobuilder', wallet: 'GBBB' },
    // admin_revoke emits `revoked`; the revoked handle must not linger.
    { kind: 'revoked' as const, handle: 'aquawolf', wallet: 'GAAA' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(
    bound.map((e) => e.handle),
    ['sorobuilder'],
  );
});

test('reduceBindings lets a handle be re-claimed after revoke', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'revoked' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GBBB' },
  ];
  const bound = reduceBindings(events);
  assert.equal(bound.length, 1);
  assert.equal(bound[0]!.wallet, 'GBBB');
});

test('reduceBindings lets a handle be re-claimed after release', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'released' as const, handle: 'aquawolf', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GBBB' },
  ];
  const bound = reduceBindings(events);
  assert.equal(bound.length, 1);
  assert.equal(bound[0]!.wallet, 'GBBB');
});

test('reduceBindings updates the handle owner on transfer', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'aquawolf', wallet: 'GOLD' },
    { kind: 'transferred' as const, handle: 'aquawolf', wallet: 'GNEW', from: 'GOLD' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(bound, [{ handle: 'aquawolf', wallet: 'GNEW' }]);
});

test('reduceBindings sorts alphabetically for stable pagination', () => {
  const events = [
    { kind: 'claimed' as const, handle: 'zeta', wallet: 'GAAA' },
    { kind: 'claimed' as const, handle: 'alpha', wallet: 'GBBB' },
  ];
  const bound = reduceBindings(events);
  assert.deepEqual(
    bound.map((e) => e.handle),
    ['alpha', 'zeta'],
  );
});

test('reduceBindings returns nothing for an empty event list (empty-state case)', () => {
  assert.deepEqual(reduceBindings([]), []);
});

test('isRegistryConfigured is false without a contract id set', () => {
  // No REGISTRY_CONTRACT_ID / NEXT_PUBLIC_IDENTITY_REGISTRY_ID in this test env.
  assert.equal(isRegistryConfigured(), false);
});

test('listDirectory never marks a curated handle as bound when the registry is unconfigured', async () => {
  const { entries, boundTotal } = await listDirectory();
  const handles = entries.map((e) => e.handle);
  assert.ok(handles.includes('aquawolf'));
  assert.ok(handles.length >= 3);

  // The regression this guards: curated demo handles were previously returned
  // indistinguishable from on-chain bindings, and the page counted them as
  // "currently bound on the Identity Registry".
  assert.ok(
    entries.every((e) => e.bound === false),
    'no handle may be marked bound without a resolve() that returned a wallet',
  );
  assert.equal(entries.find((e) => e.handle === 'aquawolf')?.wallet, '');
  assert.equal(boundTotal, null, 'an unreadable registry reports null, not 0');
});

test('listDirectory marks only handles the contract resolves as bound', async () => {
  process.env.REGISTRY_CONTRACT_ID = CONTRACT_ID;
  try {
    const server = registryStub({ aquawolf: WALLET }, 1);
    const { entries, boundTotal } = await listDirectory({ server });

    const aquawolf = entries.find((e) => e.handle === 'aquawolf');
    assert.equal(aquawolf?.bound, true);
    assert.equal(aquawolf?.wallet, WALLET);

    for (const entry of entries.filter((e) => e.handle !== 'aquawolf')) {
      assert.equal(entry.bound, false, `${entry.handle} must not be marked bound`);
      assert.equal(entry.wallet, '');
    }

    // Bound entries lead, so the real binding is never buried under previews.
    assert.equal(entries[0]!.handle, 'aquawolf');
    assert.equal(boundTotal, 1);
  } finally {
    delete process.env.REGISTRY_CONTRACT_ID;
  }
});

/**
 * A durable store stub: answers the one `wallet.findMany` the directory makes,
 * asserting it asked for on-chain primary bindings only. `rows` is whatever the
 * indexer would have written.
 */
function storeStub(
  rows: { pubkey: string; profile: { handle: string } | null }[],
  onWhere?: (where: { source: string; isPrimary: boolean }) => void,
): DirectoryStore {
  return {
    wallet: {
      async findMany(args) {
        onWhere?.(args.where);
        return rows;
      },
    },
  };
}

test('fetchIndexedDirectory reads on-chain bindings from the durable store', async () => {
  let where: { source: string; isPrimary: boolean } | undefined;
  const entries = await fetchIndexedDirectory(
    storeStub(
      [
        { pubkey: 'GBBB', profile: { handle: 'zeta' } },
        { pubkey: WALLET, profile: { handle: 'alpha' } },
      ],
      (w) => {
        where = w;
      },
    ),
  );

  // Curated seed rows are the demo manifest wearing a database; discovering
  // them here would present them as registry bindings all over again.
  assert.deepEqual(where, { source: 'onchain', isPrimary: true });
  assert.deepEqual(entries, [
    { handle: 'alpha', wallet: WALLET },
    { handle: 'zeta', wallet: 'GBBB' },
  ]);
});

test('fetchIndexedDirectory drops rows with no profile or an invalid handle', async () => {
  const entries = await fetchIndexedDirectory(
    storeStub([
      { pubkey: 'GAAA', profile: null },
      { pubkey: 'GBBB', profile: { handle: 'NOT A HANDLE' } },
      { pubkey: 'GCCC', profile: { handle: 'kept' } },
    ]),
  );
  assert.deepEqual(entries, [{ handle: 'kept', wallet: 'GCCC' }]);
});

test('fetchIndexedDirectory returns null with no database configured', async () => {
  // No DATABASE_URL in this test env — the caller must be able to tell "no
  // durable source" apart from "the indexer knows of no bindings".
  assert.equal(await fetchIndexedDirectory(), null);
});

test('fetchIndexedDirectory returns null when the store throws, so callers fall back', async () => {
  const broken: DirectoryStore = {
    wallet: {
      findMany() {
        return Promise.reject(new Error('connection refused'));
      },
    },
  };
  assert.equal(await fetchIndexedDirectory(broken), null);
});

test('listDirectory lists a handle the indexer knows but the event window has lost', async () => {
  // The regression in #182: a handle claimed more than ~11h ago is invisible to
  // getEvents, so it silently vanished from the public directory even though
  // the contract still resolves it and the indexer still has it.
  process.env.REGISTRY_CONTRACT_ID = CONTRACT_ID;
  try {
    const { entries, boundTotal, source } = await listDirectory({
      server: registryStub({ ancient: WALLET }, 1),
      store: storeStub([{ pubkey: WALLET, profile: { handle: 'ancient' } }]),
    });

    const ancient = entries.find((e) => e.handle === 'ancient');
    assert.equal(ancient?.bound, true);
    assert.equal(ancient?.wallet, WALLET);
    assert.equal(source, 'database');
    // Listed count and count() now agree, which is the acceptance criterion.
    assert.equal(entries.filter((e) => e.bound).length, boundTotal);
  } finally {
    delete process.env.REGISTRY_CONTRACT_ID;
  }
});

test('listDirectory reports the database as its source even when it holds nothing', async () => {
  // An empty durable read is an answer, not a failure: it must not silently
  // fall back to the event stream and re-acquire the ~11h horizon.
  process.env.REGISTRY_CONTRACT_ID = CONTRACT_ID;
  try {
    const { source, entries } = await listDirectory({
      server: registryStub({}, 0),
      store: storeStub([]),
    });
    assert.equal(source, 'database');
    assert.ok(
      entries.every((e) => e.bound === false),
      'curated previews only',
    );
  } finally {
    delete process.env.REGISTRY_CONTRACT_ID;
  }
});

test('listDirectory falls back to the event stream when there is no durable source', async () => {
  // No DATABASE_URL and no store injected: the page still works, on the event
  // stream, exactly as it did before. The registry is unconfigured here, so
  // the stream cannot be read either and the source degrades to "none".
  const { source } = await listDirectory();
  assert.equal(source, 'none');
});
