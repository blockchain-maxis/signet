import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpecJson } from '@signet/spec';
import { drawContractDiagram, __resetDiagramViewCache, type DiagramViewInput } from './diagram-view.ts';
import { exportDiagramFragment, type DiagramFragmentDeps } from './diagram-fragment.ts';
import type { Attribution } from '../contract-attribution.ts';

const address = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const fn = (name: string, inputs: SpecJson['functions'][number]['inputs'], outputs: SpecJson['functions'][number]['outputs'] = []) => ({
  name,
  doc: '',
  isConstructor: false,
  inputs,
  outputs,
});
const pool = { type: 'named', name: 'Pool' } as const;
const config = { type: 'named', name: 'Config' } as const;

/** 30 functions in three groups: past the collapse threshold (#502). */
export const groupedSpec: SpecJson = {
  schemaVersion: 1,
  wasmHash: 'c'.repeat(64),
  sdkVersion: '16.1.0',
  entriesXdr: [],
  functions: [
    ...Array.from({ length: 12 }, (_, i) => fn(`pool_op${i}`, [{ name: 'pool', type: pool }])),
    ...Array.from({ length: 6 }, (_, i) => fn(`admin_op${i}`, [{ name: 'config', type: config }])),
    ...Array.from({ length: 12 }, (_, i) => fn(`get_op${i}`, [], [pool])),
  ],
  types: [
    { kind: 'struct', name: 'Pool', fields: [{ name: 'config', type: config }] },
    { kind: 'struct', name: 'Config', fields: [] },
  ],
  errors: [],
  events: [],
  warnings: [],
};

const input = (over: Partial<DiagramViewInput> = {}): DiagramViewInput => ({
  handle: 'alice',
  address,
  network: 'testnet',
  spec: groupedSpec,
  calls: null,
  mutability: null,
  ...over,
});

test('past the threshold every group is one node linking to its expansion', () => {
  __resetDiagramViewCache();
  const view = drawContractDiagram(input());
  assert.equal(view.collapsible, true);
  assert.deepEqual(view.expanded, []);
  assert.match(
    view.regionHtml,
    /href="\/p\/alice\/contract\/CASF\w+\/diagram\?expand=pool" data-node-id="collapsed:pool" data-group-toggle="pool"/,
  );
  assert.match(view.regionHtml, /Function groups are collapsed: select one to draw its functions\./);
  assert.doesNotMatch(view.regionHtml, /data-node-id="fn:/);
});

test('an expanded group draws its functions and links back to collapsing it', () => {
  const view = drawContractDiagram(input({ expand: 'pool' }));
  assert.deepEqual(view.expanded, ['pool']);
  assert.match(view.regionHtml, /data-node-id="fn:pool_op0"/);
  assert.match(view.regionHtml, /<a href="\/p\/alice\/contract\/CASF\w+\/diagram" data-group-toggle="pool"[^>]*>Collapse pool<\/a>/);
  // Expanding another keeps this one: the link carries both, sorted.
  assert.match(view.regionHtml, /diagram\?expand=admin%2Cpool" data-node-id="collapsed:admin"/);
});

test('permuted expand lists draw the same state; unknown names are never echoed', () => {
  const a = drawContractDiagram(input({ expand: 'pool,admin' }));
  const b = drawContractDiagram(input({ expand: 'admin,pool,pool' }));
  assert.equal(a.regionHtml, b.regionHtml);
  const hostile = drawContractDiagram(input({ expand: '<script>alert(1)</script>' }));
  assert.equal(hostile.regionHtml, drawContractDiagram(input()).regionHtml);
  assert.doesNotMatch(hostile.regionHtml, /<script/);
});

test('a contract below the threshold has no group controls', () => {
  const small = { ...groupedSpec, wasmHash: 'd'.repeat(64), functions: groupedSpec.functions.slice(0, 5) };
  const view = drawContractDiagram(input({ spec: small, expand: 'pool' }));
  assert.equal(view.collapsible, false);
  assert.doesNotMatch(view.regionHtml, /data-group-controls/);
  assert.match(view.regionHtml, /data-node-id="fn:pool_op0"/);
});

const attributed: Attribution = {
  status: 'attributed',
  source: 'database',
  contract: { address, network: 'testnet', wasmHash: 'c'.repeat(64), deployerPubkey: '', deployTxHash: '', deployedAt: '' },
};
const deps = (attribution: Attribution = attributed): DiagramFragmentDeps => ({
  attribute: async () => attribution,
  loadSpec: async () => ({ ok: true, spec: groupedSpec, wasmHash: 'c'.repeat(64), source: 'memory' }),
  loadCalls: async () => null,
  loadMutability: async () => null,
});
const request = (query: string) => new Request(`https://signet.example/p/alice/contract/${address}/diagram/fragment${query}`);

test('the fragment route returns the same region the page draws', async () => {
  const res = await exportDiagramFragment(request('?expand=pool'), { handle: 'alice', address }, deps());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await res.text(), drawContractDiagram(input({ expand: 'pool' })).regionHtml);
  const hostile = await exportDiagramFragment(request('?expand=%3Cscript%3E'), { handle: 'alice', address }, deps());
  assert.doesNotMatch(await hostile.text(), /<script/);
});

test('the fragment route repeats the attribution gate', async () => {
  for (const status of ['invalid', 'not-attributed', 'unavailable'] as const) {
    const d = deps({ status });
    d.loadSpec = async () => {
      throw new Error('must not load');
    };
    const res = await exportDiagramFragment(request(''), { handle: 'alice', address }, d);
    assert.equal(res.status, status === 'unavailable' ? 503 : 404);
  }
});
