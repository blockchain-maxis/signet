import { xdr } from '@stellar/stellar-sdk';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportContractDiagram, type DiagramExportDeps } from './diagram-export.ts';
import type { Attribution } from '../contract-attribution.ts';
import type { SpecJson } from '@signet/spec';

const address = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const hash = 'a'.repeat(64);
const params = { handle: 'alice', address };
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
const attributed: Attribution = {
  status: 'attributed',
  source: 'database',
  contract: {
    address,
    network: 'testnet',
    wasmHash: 'b'.repeat(64),
    deployerPubkey: '',
    deployTxHash: '',
    deployedAt: '',
  },
};
function dependencies(attribution = attributed): DiagramExportDeps {
  return {
    attribute: async () => attribution,
    loadSpec: async () => ({ ok: true, spec, wasmHash: hash, source: 'memory' }),
  };
}
const request = (query = '') =>
  new Request(`https://signet.example/p/alice/contract/${address}/diagram.svg${query}`);
for (const status of ['invalid', 'not-attributed', 'unavailable'] as const) {
  test(`export gates ${status} before loading the interface`, async () => {
    const deps = dependencies({ status });
    deps.loadSpec = async () => {
      throw new Error('must not load');
    };
    const res = await exportContractDiagram(request(), params, deps);
    assert.equal(res.status, status === 'unavailable' ? 503 : 404);
    assert.equal(res.headers.get('content-disposition'), null);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
}
for (const theme of ['dark', 'light', 'auto']) {
  test(`export ${theme} has attachment headers and the resolved WASM provenance`, async () => {
    const res = await exportContractDiagram(request(`?theme=${theme}`), params, dependencies());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.equal(
      res.headers.get('content-disposition'),
      `attachment; filename="signet-${address}-${theme}.svg"`,
    );
    assert.ok((await res.text()).includes(hash));
    assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/);
  });
}
test('theme defaults to auto, and unsupported themes are rejected', async () => {
  assert.match(
    (await exportContractDiagram(request(), params, dependencies())).headers.get(
      'content-disposition',
    )!,
    /auto.svg/,
  );
  assert.equal(
    (await exportContractDiagram(request('?theme=invalid'), params, dependencies())).status,
    400,
  );
});
test('interface failure returns no attachment', async () => {
  const deps = dependencies();
  deps.loadSpec = async () => ({
    ok: false,
    failure: { kind: 'wrong_network', network: 'mainnet', expectedNetwork: 'testnet' },
  });
  const res = await exportContractDiagram(request(), params, deps);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('content-disposition'), null);
});

test('invalid interface data fails closed without disclosing the parser error', async () => {
  const deps = dependencies();
  deps.loadSpec = async () => ({
    ok: true,
    spec: { ...spec, entriesXdr: ['not-valid-xdr'] },
    wasmHash: hash,
    source: 'memory',
  });
  const res = await exportContractDiagram(request(), params, deps);
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'Diagram unavailable');
});

test('oversized diagrams are rejected before layout/export', async () => {
  const deps = dependencies();
  const entriesXdr = Array.from({ length: 61 }, (_, i) =>
    xdr.ScSpecEntry.scSpecEntryFunctionV0(
      new xdr.ScSpecFunctionV0({ doc: '', name: `function_${i}`, inputs: [], outputs: [] }),
    ).toXDR('base64'),
  );
  deps.loadSpec = async () => ({
    ok: true,
    spec: { ...spec, entriesXdr },
    wasmHash: hash,
    source: 'memory',
  });
  const res = await exportContractDiagram(request(), params, deps);
  assert.equal(res.status, 422);
  assert.equal(res.headers.get('content-disposition'), null);
});
