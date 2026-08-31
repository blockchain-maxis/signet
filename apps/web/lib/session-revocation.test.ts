import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_STALE_MS,
  MemoryRevocationStore,
  REFRESH_MS,
  UpstashRevocationStore,
  __resetRevocationStore,
  isRevoked,
  revokeAddress,
  revokeSession,
  setRevocationStore,
  type RevocationList,
  type RevocationStore,
} from './session-revocation.ts';

const later = (): number => Date.now() + 60_000;
const session = (address: string, sid?: string) => ({
  address,
  ...(sid ? { sid } : {}),
  iat: Date.now() - 1_000,
  exp: later(),
});

/** A store that counts reads, so the caching claim can be asserted directly. */
function countingStore(inner: RevocationStore = new MemoryRevocationStore()) {
  let reads = 0;
  const store: RevocationStore & { reads: () => number; failing: boolean } = {
    failing: false,
    reads: () => reads,
    put: (key, rule) => inner.put(key, rule),
    async snapshot() {
      reads += 1;
      return store.failing ? null : inner.snapshot();
    },
  };
  return store;
}

test('the happy path does not read the store per request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = countingStore();
  setRevocationStore(store);

  for (let i = 0; i < 50; i++) assert.equal(await isRevoked(session('GWALLET')), false);
  assert.equal(store.reads(), 1, 'one snapshot should serve every request in the interval');

  t.mock.timers.tick(REFRESH_MS + 1);
  await isRevoked(session('GWALLET'));
  assert.equal(store.reads(), 2, 'the snapshot should be refreshed once the interval lapses');

  __resetRevocationStore();
});

test('a failing store keeps serving the last snapshot, then fails closed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const store = countingStore();
  setRevocationStore(store);

  const live = session('GWALLET');
  assert.equal(await isRevoked(live), false);

  store.failing = true;
  t.mock.timers.tick(REFRESH_MS + 1);
  // A blip must not sign the world out…
  assert.equal(await isRevoked(live), false);

  t.mock.timers.tick(MAX_STALE_MS);
  // …but an outage must not silently mean "nobody is revoked" either.
  assert.equal(await isRevoked(live), true);

  __resetRevocationStore();
});

test('concurrent verifications share one refresh', async () => {
  __resetRevocationStore();
  const store = countingStore();
  setRevocationStore(store);

  await Promise.all(Array.from({ length: 20 }, () => isRevoked(session('GWALLET'))));
  assert.equal(store.reads(), 1);

  __resetRevocationStore();
});

test('expired entries are dropped from the store, not just ignored', async () => {
  const store = new MemoryRevocationStore();
  await store.put('a:GWALLET', { before: Date.now(), expires: Date.now() - 1 });
  await store.put('s:live', { expires: later() });

  const first = await store.snapshot();
  assert.deepEqual([...first.keys()], ['s:live']);
  // Dropped from the backing map too, so the list cannot grow without bound.
  assert.deepEqual([...(await store.snapshot()).keys()], ['s:live']);
});

test('a store write that is not confirmed surfaces as a failure', async () => {
  setRevocationStore({
    async put() {
      throw new Error('store down');
    },
    async snapshot() {
      return new Map() as RevocationList;
    },
  });
  // The caller has to be able to tell "signed out" from "nothing happened".
  await assert.rejects(() => revokeAddress('GWALLET', { until: later() }), /store down/);
  await assert.rejects(() => revokeSession('sid', later()), /store down/);
  __resetRevocationStore();
});

// ── Upstash store ─────────────────────────────────────────────────────────

/** Stub `fetch`, capturing the pipelines sent and replying with `replies`. */
function stubFetch(replies: unknown[][]) {
  const sent: unknown[][] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as unknown[]);
    const reply = replies.shift() ?? [];
    return new Response(JSON.stringify(reply.map((result) => ({ result }))), { status: 200 });
  });
  return { sent, restore: () => fetchMock.mock.restore() };
}

test('the Upstash store reads the whole list in one round trip and prunes it', async () => {
  const expires = later();
  const { sent, restore } = stubFetch([
    [
      [
        'a:GWALLET',
        JSON.stringify({ before: 1, expires }),
        's:stale',
        JSON.stringify({ expires: Date.now() - 1 }),
      ],
    ],
    [1],
  ]);
  try {
    const store = new UpstashRevocationStore('https://example.upstash.io/', 'token');
    const list = await store.snapshot();

    assert.deepEqual([...list!.keys()], ['a:GWALLET']);
    assert.deepEqual(sent[0], [['HGETALL', 'signet:revocations']]);
    // The expired field is deleted rather than re-read on every refresh.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent[1], [['HDEL', 'signet:revocations', 's:stale']]);
  } finally {
    restore();
  }
});

test('an Upstash error reads as "unknown", never as "empty list"', async () => {
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => new Response('nope', { status: 500 }),
  );
  try {
    const store = new UpstashRevocationStore('https://example.upstash.io', 'token');
    // An empty Map here would mean "nobody is revoked" — the fail-open bug.
    assert.equal(await store.snapshot(), null);
  } finally {
    fetchMock.mock.restore();
  }
});
