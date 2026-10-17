import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr } from '@stellar/stellar-sdk';
import type { SpecFunction, SpecJson, SpecType } from '@signet/spec';
import type { Attribution } from '../contract-attribution.ts';
import { clearDiagramCache } from './contract-diagram.ts';
import { serveDiagramFragment, type DiagramFragmentDeps } from './diagram-fragment.ts';

const address = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const params = { handle: 'alice', address };
const ENTRY = xdr.ScSpecEntry.scSpecEntryFunctionV0(
  new xdr.ScSpecFunctionV0({ doc: '', name: '__fixture', inputs: [], outputs: [] }),
).toXDR('base64');

const fn = (name: string, input?: string): SpecFunction => ({
  name,
  doc: '',
  isConstructor: false,
  inputs: input ? [{ name: 'value', type: { type: 'named', name: input } }] : [],
  outputs: [],
});
const pool: SpecType = { kind: 'struct', name: 'Pool', fields: [] };

const spec: SpecJson = {
  schemaVersion: 1,
  wasmHash: 'a'.repeat(64),
  sdkVersion: '16.1.0',
  entriesXdr: [ENTRY],
  functions: [
    ...Array.from({ length: 13 }, (_, i) => fn(`pool_${i}`, 'Pool')),
    ...Array.from({ length: 13 }, (_, i) => fn(`admin_${i}`)),
  ],
  types: [pool],
  errors: [],
  events: [],
  warnings: [],
};

const attributed: Attribution = {
  status: 'attributed',
  source: 'database',
  contract: {
    address,
    network: 'testnet',
    wasmHash: spec.wasmHash,
    deployerPubkey: '',
    deployTxHash: '',
    deployedAt: '',
  },
};

function deps(attribution: Attribution = attributed): DiagramFragmentDeps {
  return {
    attribute: async () => attribution,
    loadSpec: async () => ({
      ok: true,
      spec,
      wasmHash: spec.wasmHash,
      source: 'memory',
    }),
  };
}

const request = (query = '') =>
  new Request(`https://signet.example/p/alice/contract/${address}/diagram/fragment${query}`);

for (const status of ['invalid', 'not-attributed'] as const) {
  test(`${status} is a 404 before the interface is loaded`, async () => {
    const seams = deps({ status });
    seams.loadSpec = async () => {
      throw new Error('must not load');
    };
    const response = await serveDiagramFragment(request(), params, seams);
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.headers.get('content-type') ?? '', /svg/);
  });
}

test('unavailable attribution is a 503', async () => {
  const response = await serveDiagramFragment(request(), params, deps({ status: 'unavailable' }));
  assert.equal(response.status, 503);
});

test('an unreadable interface is a 503, not a partial SVG', async () => {
  const seams = deps();
  seams.loadSpec = async () => ({
    ok: false,
    failure: { kind: 'unavailable' },
  });
  const response = await serveDiagramFragment(request(), params, seams);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'Contract interface unavailable');
});

test('a valid request returns the same SVG type the page inlines', async () => {
  clearDiagramCache();
  const response = await serveDiagramFragment(request('?expand=pool'), params, deps());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
  const svg = await response.text();
  assert.match(svg, /^<svg/);
  assert.match(svg, /data-node-id="fn:pool_0"/);
  assert.match(svg, /data-node-id="group:admin"/);
});

test('unknown names in the query are ignored and never appear in the fragment', async () => {
  clearDiagramCache();
  const response = await serveDiagramFragment(
    request('?expand=%3Cscript%3E&types=NotAType'),
    params,
    deps(),
  );
  assert.equal(response.status, 200);
  const svg = await response.text();
  assert.doesNotMatch(svg, /script|NotAType/);
  assert.match(svg, /data-node-id="group:pool"/);
});
