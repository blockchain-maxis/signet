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
