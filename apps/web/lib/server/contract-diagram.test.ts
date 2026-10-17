import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xdr } from '@stellar/stellar-sdk';
import type { SpecFunction, SpecJson, SpecType, TypeRef } from '@signet/spec';
import { diagramNamesFromSpec, parseDiagramState } from '../diagram-state.ts';
import {
  clearDiagramCache,
  diagramCacheSize,
  renderContractDiagram,
  type ContractDiagramInput,
} from './contract-diagram.ts';

const named = (name: string): TypeRef => ({ type: 'named', name });

function fn(name: string, inputs: string[] = [], outputs: string[] = []): SpecFunction {
  return {
    name,
    doc: '',
    isConstructor: false,
    inputs: inputs.map((type, i) => ({ name: `arg${i}`, type: named(type) })),
    outputs: outputs.map(named),
  };
}

function struct(name: string, fields: { name: string; type: string }[] = []): SpecType {
  return {
    kind: 'struct',
    name,
    fields: fields.map((field) => ({ name: field.name, type: named(field.type) })),
  };
}

/** `fromSpecJson` reconstructs the SDK's Spec, which refuses an empty entry list. */
const ENTRY = xdr.ScSpecEntry.scSpecEntryFunctionV0(
  new xdr.ScSpecFunctionV0({ doc: '', name: '__fixture', inputs: [], outputs: [] }),
).toXDR('base64');

function specOf(functions: SpecFunction[], types: SpecType[] = []): SpecJson {
  return {
    schemaVersion: 1,
    wasmHash: 'a'.repeat(64),
    sdkVersion: '16.1.0',
    entriesXdr: [ENTRY],
    functions,
    types,
    errors: [],
    events: [],
    warnings: [],
  };
}

function input(
  spec: SpecJson,
  query = '',
): Omit<ContractDiagramInput, 'names' | 'state'> & {
  names: ReturnType<typeof diagramNamesFromSpec>;
  state: ReturnType<typeof parseDiagramState>;
} {
  const names = diagramNamesFromSpec(spec);
  const state = parseDiagramState(new URLSearchParams(query), names);
  return {
    spec,
    names,
    state,
    contractBase: '/p/alice/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
    diagramPath:
      '/p/alice/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN/diagram',
    wasmHash: spec.wasmHash,
    title: 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN contract interface',
  };
}

const LARGE = specOf(
  [
    ...Array.from({ length: 13 }, (_, i) => fn(`pool_${i}`, ['Pool'])),
    ...Array.from({ length: 13 }, (_, i) => fn(`admin_${i}`)),
  ],
  [struct('Pool')],
);

test('a large contract starts collapsed and its group is one expanding link', () => {
  clearDiagramCache();
  const result = renderContractDiagram(input(LARGE));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.svg, /data-node-id="group:pool"/);
  assert.match(result.svg, /pool_\* \(13\)/);
  assert.match(result.svg, /data-expand-group="pool"/);
  assert.match(result.svg, /href="[^"]*\/diagram\?expand=pool"/);
  assert.doesNotMatch(result.svg, /fn:pool_0/);
});

test('?expand=pool opens only that group', () => {
  clearDiagramCache();
  const result = renderContractDiagram(input(LARGE, 'expand=pool'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.svg, /data-node-id="fn:pool_0"/);
  assert.doesNotMatch(result.svg, /data-node-id="group:pool"/);
  assert.match(result.svg, /data-node-id="group:admin"/);
  // The open group has a control back to the all-collapsed URL.
  assert.match(result.svg, /data-collapse-group="pool"/);
  assert.match(result.svg, /href="\/p\/alice\/contract\/[^"]+\/diagram"/);
});

test('a small contract opens fully and has no group controls', () => {
  clearDiagramCache();
  const small = specOf([fn('claim'), fn('resolve'), fn('count')]);
  const result = renderContractDiagram(input(small));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.svg, /data-node-id="fn:claim"/);
  assert.doesNotMatch(result.svg, /data-node-id="group:/);
  assert.doesNotMatch(result.svg, /data-collapse-group/);
});

test('types= opens a named type stub and unknown names are never echoed', () => {
  clearDiagramCache();
  const nested = specOf(
    [fn('read', [], ['Outer'])],
    [struct('Outer', [{ name: 'pool', type: 'Pool' }]), struct('Pool')],
  );
  const closed = renderContractDiagram(input(nested));
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.match(closed.svg, /type:Pool/);
  assert.match(closed.svg, /Pool \+0/);

  const opened = renderContractDiagram(input(nested, 'types=Pool'));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.doesNotMatch(opened.svg, /Pool \+0/);
  assert.match(opened.svg, /data-node-id="type:Pool"/);

  const hostile = renderContractDiagram(input(nested, 'types=%3Cscript%3E,Pool'));
  assert.equal(hostile.ok, true);
  if (!hostile.ok) return;
  assert.doesNotMatch(hostile.svg, /script/i);
});

test('permuted states share one cache entry and each distinct state is its own', () => {
  clearDiagramCache();
  const first = renderContractDiagram(input(LARGE, 'expand=pool,admin'));
  const second = renderContractDiagram(input(LARGE, 'expand=admin,pool'));
  assert.equal(first.ok && second.ok, true);
  assert.equal(diagramCacheSize(), 1);
  if (first.ok && second.ok) assert.equal(first.svg, second.svg);

  renderContractDiagram(input(LARGE, 'expand=pool'));
  assert.equal(diagramCacheSize(), 2);
});

test('the cache key includes the contract route', () => {
  clearDiagramCache();
  const base = input(LARGE);
  renderContractDiagram(base);
  renderContractDiagram({
    ...base,
    contractBase: '/p/bob/contract/CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN',
  });
  assert.equal(diagramCacheSize(), 2);
});

test('an unsupported spec schema is a value, not a throw', () => {
  clearDiagramCache();
  const invalid = { ...LARGE, schemaVersion: 2 as unknown as 1 };
  const result = renderContractDiagram(input(invalid));
  assert.deepEqual(result, { ok: false, reason: 'invalid_spec' });
  assert.equal(diagramCacheSize(), 0);
});
