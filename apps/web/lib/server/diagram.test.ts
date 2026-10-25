import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { xdr } from '@stellar/stellar-sdk';
import type { SpecJson } from '@signet/spec';
import { LAYOUT_VERSION, type PositionedDiagramModel } from '@signet/visualiser';
import {
  getDiagram,
  MemoryDiagramStore,
  PrismaDiagramStore,
  __resetDiagramStore,
  setDiagramStore,
  type DiagramDeps,
} from './diagram.ts';

const address = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const hash = 'a'.repeat(64);

const spec: SpecJson = {
  schemaVersion: 1,
  wasmHash: hash,
  sdkVersion: '16.1.0',
  entriesXdr: [
    xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({ doc: '', name: 'read', inputs: [], outputs: [] }),
    ).toXDR('base64'),
  ],
  functions: [],
  types: [],
  errors: [],
  events: [],
  warnings: [],
};

const fakeLayout: PositionedDiagramModel = {
  layoutVersion: LAYOUT_VERSION,
  width: 500,
  height: 300,
  nodes: [],
  edges: [],
  groups: [],
};

beforeEach(() => {
  __resetDiagramStore();
});

test('first call computes layout and caches it; second call with same hash does not call layout (spy)', async () => {
  let layoutCalls = 0;
  const layoutSpy = () => {
    layoutCalls += 1;
    return fakeLayout;
  };

  const deps: DiagramDeps = {
    getContractSpec: async () => ({
      ok: true,
      spec,
      wasmHash: hash,
      source: 'memory',
    }),
    layout: layoutSpy,
  };

  const res1 = await getDiagram(address, 'testnet', deps);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.wasmHash, hash);
    assert.equal(res1.layoutVersion, LAYOUT_VERSION);
    assert.deepEqual(res1.layout, fakeLayout);
  }
  assert.equal(layoutCalls, 1);

  // Second call with same hash should hit cache and NOT invoke layout spy
  const res2 = await getDiagram(address, 'testnet', deps);
  assert.equal(res2.ok, true);
  if (res2.ok) {
    assert.equal(res2.wasmHash, hash);
    assert.equal(res2.layoutVersion, LAYOUT_VERSION);
    assert.deepEqual(res2.layout, fakeLayout);
  }
  assert.equal(layoutCalls, 1, 'layout spy must not be called on cache hit');
});

test('bumping layoutVersion triggers a recompute and updates stored layout', async () => {
  let layoutCalls = 0;
  const layoutSpy = () => {
    layoutCalls += 1;
    return { ...fakeLayout, width: 600 + layoutCalls };
  };

  const deps: DiagramDeps = {
    getContractSpec: async () => ({
      ok: true,
      spec,
      wasmHash: hash,
      source: 'memory',
    }),
    layout: layoutSpy,
    layoutVersion: 1,
  };

  const res1 = await getDiagram(address, 'testnet', deps);
  assert.equal(res1.ok, true);
  assert.equal(layoutCalls, 1);
  if (res1.ok) {
    assert.equal(res1.layoutVersion, 1);
    assert.equal(res1.layout.width, 601);
  }

  // Second call with same version hits cache
  const res2 = await getDiagram(address, 'testnet', deps);
  assert.equal(res2.ok, true);
  assert.equal(layoutCalls, 1);

  // Third call with bumped layoutVersion invalidates and recomputes
  const bumpedDeps: DiagramDeps = {
    ...deps,
    layoutVersion: 2,
  };
  const res3 = await getDiagram(address, 'testnet', bumpedDeps);
  assert.equal(res3.ok, true);
  assert.equal(layoutCalls, 2, 'layout must be recomputed when layoutVersion changes');
  if (res3.ok) {
    assert.equal(res3.layoutVersion, 2);
    assert.equal(res3.layout.width, 602);
  }
});

test('a layout computation that throws returns ok: false without crashing', async () => {
  const deps: DiagramDeps = {
    getContractSpec: async () => ({
      ok: true,
      spec,
      wasmHash: hash,
      source: 'memory',
    }),
    layout: () => {
      throw new Error('Graph cycle layout error');
    },
  };

  const res = await getDiagram(address, 'testnet', deps);
  assert.equal(res.ok, false);
});

test('returns ok: false when contract spec fails to resolve', async () => {
  const deps: DiagramDeps = {
    getContractSpec: async () => ({
      ok: false,
      failure: { kind: 'wrong_network', network: 'mainnet', expectedNetwork: 'testnet' },
    }),
  };

  const res = await getDiagram(address, 'mainnet', deps);
  assert.equal(res.ok, false);
});

test('works with PrismaDiagramStore when database is injected', async () => {
  let dbRow: { layout: any; layoutVersion: number | null } | null = null;
  const mockDb = {
    contractSpec: {
      findUnique: async () => dbRow,
      update: async ({ data }: { data: any }) => {
        dbRow = { layout: data.layout, layoutVersion: data.layoutVersion };
      },
    },
  };

  const store = new PrismaDiagramStore(mockDb);
  let layoutCalls = 0;
  const deps: DiagramDeps = {
    getContractSpec: async () => ({
      ok: true,
      spec,
      wasmHash: hash,
      source: 'store',
    }),
    layout: () => {
      layoutCalls += 1;
      return fakeLayout;
    },
    store,
  };

  const res1 = await getDiagram(address, 'testnet', deps);
  assert.equal(res1.ok, true);
  assert.equal(layoutCalls, 1);
  assert.ok(dbRow !== null);
  const updatedRow: { layout: any; layoutVersion: number | null } = dbRow;
  assert.equal(updatedRow.layoutVersion, LAYOUT_VERSION);

  // Call again: should read from store and not recompute
  const res2 = await getDiagram(address, 'testnet', deps);
  assert.equal(res2.ok, true);
  assert.equal(layoutCalls, 1);
});

// ── Mutability marks (#511) ────────────────────────────────────────────

import { Address } from '@stellar/stellar-sdk';
import { __resetMutabilityCache, getMutabilityOverlay, type InvocationRow } from './diagram.ts';

const twoFunctions: SpecJson = {
  ...spec,
  entriesXdr: ['read', 'write'].map((name) =>
    xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({ doc: '', name, inputs: [], outputs: [] }),
    ).toXDR('base64'),
  ),
  functions: ['read', 'write'].map((name) => ({ name, doc: '', isConstructor: false, inputs: [], outputs: [] })),
};

const stateKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: Address.fromString(address).toScAddress(),
    key: xdr.ScVal.scvSymbol('Count'),
    durability: xdr.ContractDataDurability.persistent(),
  }),
).toXDR('base64');

const row = (fn: string, ledger: number, writes: boolean, wasmHash = hash): InvocationRow => ({
  function: fn,
  txHash: `${fn}-${ledger}`.padEnd(64, '0'),
  ledger,
  successful: true,
  wasmHash,
  readOnly: writes ? [] : [stateKey],
  readWrite: writes ? [stateKey] : [],
  changed: writes ? [stateKey] : [],
});

const specDeps = { getContractSpec: async () => ({ ok: true as const, spec: twoFunctions, wasmHash: hash }) as never };

test('stored invocations become marks against the current spec', async () => {
  __resetMutabilityCache();
  const overlay = await getMutabilityOverlay(address, 'testnet', {
    ...specDeps,
    invocations: async ({ fn }) => (fn === 'write' ? [row('write', 120, true), row('write', 110, true)] : [row('read', 115, false)]),
  });
  assert.ok(overlay);
  assert.equal(overlay.marks.write?.kind, 'writes');
  assert.equal(overlay.marks.read?.kind, 'no-writes-seen');
  assert.equal(overlay.observations, 3);
  assert.deepEqual([overlay.firstLedger, overlay.lastLedger], [110, 120]);
  assert.equal(overlay.reason, null);
  assert.match(overlay.retentionNote, /7 days/);
});

test('with no database every mark is unknown, and says why', async () => {
  __resetMutabilityCache();
  const overlay = await getMutabilityOverlay(address, 'testnet', { ...specDeps, invocations: async () => null });
  assert.ok(overlay);
  assert.deepEqual(Object.values(overlay.marks).map((m) => m.kind), ['unknown', 'unknown']);
  assert.equal(overlay.reason, 'No indexed observations in this environment.');
});

test('invocations of an older code version are counted as stale, not used', async () => {
  __resetMutabilityCache();
  const overlay = await getMutabilityOverlay(address, 'testnet', {
    ...specDeps,
    invocations: async ({ fn }) => (fn === 'write' ? [row('write', 90, true, 'b'.repeat(64))] : []),
  });
  assert.ok(overlay);
  assert.equal(overlay.marks.write?.kind, 'unknown');
  assert.equal(overlay.staleObservations, 1);
  assert.equal(overlay.observations, 0);
});

test('marks are cached for five minutes', async () => {
  __resetMutabilityCache();
  let reads = 0;
  let clock = 0;
  const deps = { ...specDeps, now: () => clock, invocations: async () => (reads++, []) };
  await getMutabilityOverlay(address, 'testnet', deps);
  await getMutabilityOverlay(address, 'testnet', deps);
  assert.equal(reads, 2); // two functions, read once
  clock = 5 * 60 * 1000 + 1;
  await getMutabilityOverlay(address, 'testnet', deps);
  assert.equal(reads, 4);
});

// ── Instance storage (#514) ────────────────────────────────────────────

import { xdr as X } from '@stellar/stellar-sdk';
import {
  getInstanceStorage,
  INSTANCE_ARCHIVED,
  __resetInstanceStorage,
  type InstanceStorageServer,
} from './diagram.ts';

const admin = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

/** The registry's instance entry, as `IdentityRegistry::init` and one `register` leave it. */
function registryInstance(extra: X.ScMapEntry[] = []): X.LedgerEntryData {
  return X.LedgerEntryData.contractData(
    new X.ContractDataEntry({
      ext: new X.ExtensionPoint(0),
      contract: new Address(address).toScAddress(),
      key: X.ScVal.scvLedgerKeyContractInstance(),
      durability: X.ContractDataDurability.persistent(),
      val: X.ScVal.scvContractInstance(
        new X.ScContractInstance({
          executable: X.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 0xab)),
          storage: [
            new X.ScMapEntry({ key: X.ScVal.scvVec([X.ScVal.scvSymbol('Admin')]), val: new Address(admin).toScVal() }),
            new X.ScMapEntry({ key: X.ScVal.scvVec([X.ScVal.scvSymbol('Count')]), val: X.ScVal.scvU32(7) }),
            ...extra,
          ],
        }),
      ),
    }),
  );
}

const registrySpec: SpecJson = {
  ...spec,
  entriesXdr: [
    ...spec.entriesXdr,
    X.ScSpecEntry.scSpecEntryUdtUnionV0(
      new X.ScSpecUdtUnionV0({
        doc: '',
        lib: '',
        name: 'DataKey',
        cases: ['Admin', 'Count'].map((name) =>
          X.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseVoidV0(new X.ScSpecUdtUnionCaseVoidV0({ doc: '', name })),
        ),
      }),
    ).toXDR('base64'),
  ],
  types: [
    {
      kind: 'union',
      name: 'DataKey',
      cases: ['Admin', 'Count'].map((name) => ({ name, fields: [] })),
    },
  ],
};

function stubServer(answer: () => Promise<Awaited<ReturnType<InstanceStorageServer['getLedgerEntries']>>>) {
  let calls = 0;
  const server: InstanceStorageServer = {
    getLedgerEntries: () => {
      calls++;
      return answer();
    },
  };
  return { server, calls: () => calls };
}

test('getInstanceStorage: decodes the registry instance entry at the ledger read', async () => {
  __resetInstanceStorage();
  const { server, calls } = stubServer(async () => ({
    latestLedger: 5_200_000,
    entries: [{ val: registryInstance(), liveUntilLedgerSeq: 5_300_000 }],
  }));
  const deps = {
    server,
    getContractSpec: async () => ({ ok: true as const, spec: registrySpec, source: 'memory' as const, wasmHash: hash }),
    now: () => 1_000,
  };
  const storage = await getInstanceStorage(address, 'testnet', deps);
  assert.equal(storage.status, 'ok');
  assert.equal(storage.ledger, 5_200_000);
  if (storage.status !== 'ok') return;
  assert.equal(storage.liveUntilLedger, 5_300_000);
  assert.deepEqual(storage.entries.map((e) => [e.key, e.shape, e.valueType, e.valuePreview]), [
    ['[Admin]', 'Admin', 'Address', admin],
    ['[Count]', 'Count', 'U32', '7'],
  ]);
  assert.ok(storage.entries.every((e) => e.specType === 'DataKey'));
  // Read again within the TTL: no second RPC call.
  await getInstanceStorage(address, 'testnet', deps);
  assert.equal(calls(), 1);
});

test('getInstanceStorage: bytes are shown as a length and a prefix, long values cut', async () => {
  __resetInstanceStorage();
  const { server } = stubServer(async () => ({
    latestLedger: 10,
    entries: [
      {
        val: registryInstance([
          new X.ScMapEntry({ key: X.ScVal.scvSymbol('Hash'), val: X.ScVal.scvBytes(Buffer.alloc(32, 0xcd)) }),
          new X.ScMapEntry({ key: X.ScVal.scvSymbol('Note'), val: X.ScVal.scvString('x'.repeat(500)) }),
        ]),
      },
    ],
  }));
  const storage = await getInstanceStorage(address, 'testnet', {
    server,
    getContractSpec: async () => ({ ok: false as const, failure: { reason: 'not-found' } }) as never,
  });
  assert.equal(storage.status, 'ok');
  if (storage.status !== 'ok') return;
  const hash = storage.entries.find((e) => e.shape === 'Hash')!;
  assert.equal(hash.valuePreview, '32 bytes 0xcdcdcdcdcdcdcdcd…');
  assert.equal(hash.specType, undefined);
  const note = storage.entries.find((e) => e.shape === 'Note')!;
  assert.equal(note.valuePreview.length, 120);
  assert.ok(note.valuePreview.endsWith('…'));
});

test('getInstanceStorage: an archived or missing entry is reported, with the ledger, not thrown', async () => {
  __resetInstanceStorage();
  const archived = stubServer(async () => ({
    latestLedger: 5_200_000,
    entries: [{ val: registryInstance(), liveUntilLedgerSeq: 5_100_000 }],
  }));
  const a = await getInstanceStorage(address, 'testnet', { server: archived.server });
  assert.deepEqual(a, { status: 'archived', ledger: 5_200_000, reason: INSTANCE_ARCHIVED });

  const missing = stubServer(async () => ({ latestLedger: 5_200_001, entries: [] }));
  const m = await getInstanceStorage(address, 'testnet', { server: missing.server });
  assert.equal(m.status, 'missing');
  assert.equal(m.ledger, 5_200_001);
  assert.match((m as { reason: string }).reason, /restore needed to read/);
  // Neither is cached: a restored entry shows on the next read.
  await getInstanceStorage(address, 'testnet', { server: missing.server });
  assert.equal(missing.calls(), 2);
});

test('getInstanceStorage: an RPC timeout is reported as unavailable', async () => {
  __resetInstanceStorage();
  const hung = stubServer(() => new Promise(() => {}));
  const storage = await getInstanceStorage(address, 'testnet', { server: hung.server, timeoutMs: 20 });
  assert.equal(storage.status, 'unavailable');
  assert.equal(storage.ledger, null);
  const failing = stubServer(async () => {
    throw new Error('ECONNREFUSED');
  });
  assert.equal((await getInstanceStorage(address, 'testnet', { server: failing.server })).status, 'unavailable');
});
