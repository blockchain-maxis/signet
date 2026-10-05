import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contract, xdr } from '@stellar/stellar-sdk';
import { buildSpecViews, parseContractSpec } from '@signet/spec';
import type { ContractSpec } from '@signet/spec';
import { buildContractGraph, functionNodeId, typeNodeId } from './graph.ts';
import type { GraphEdge, GraphNode } from './graph.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'fixtures');

/** A fixture WASM from `@signet/spec`, decoded by the real reader. */
function fixtureSpec(name: string): ContractSpec {
  return parseContractSpec(readFileSync(join(FIXTURES, `${name}.wasm`)));
}

// --- hand-built specs: shapes the on-chain fixtures do not contain ---------

const u32 = () => xdr.ScSpecTypeDef.scSpecTypeU32();
const udt = (name: string) => xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));
const option = (valueType: xdr.ScSpecTypeDef) =>
  xdr.ScSpecTypeDef.scSpecTypeOption(new xdr.ScSpecTypeOption({ valueType }));
const vec = (elementType: xdr.ScSpecTypeDef) =>
  xdr.ScSpecTypeDef.scSpecTypeVec(new xdr.ScSpecTypeVec({ elementType }));
const map = (keyType: xdr.ScSpecTypeDef, valueType: xdr.ScSpecTypeDef) =>
  xdr.ScSpecTypeDef.scSpecTypeMap(new xdr.ScSpecTypeMap({ keyType, valueType }));
const result = (okType: xdr.ScSpecTypeDef, errorType: xdr.ScSpecTypeDef) =>
  xdr.ScSpecTypeDef.scSpecTypeResult(new xdr.ScSpecTypeResult({ okType, errorType }));

type Params = [name: string, type: xdr.ScSpecTypeDef][];

function fn(name: string, inputs: Params, outputs: xdr.ScSpecTypeDef[]): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: '',
      name,
      inputs: inputs.map(([n, type]) => new xdr.ScSpecFunctionInputV0({ doc: '', name: n, type })),
      outputs,
    }),
  );
}

function struct(name: string, fields: Params): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtStructV0(
    new xdr.ScSpecUdtStructV0({
      doc: '',
      lib: '',
      name,
      fields: fields.map(([n, type]) => new xdr.ScSpecUdtStructFieldV0({ doc: '', name: n, type })),
    }),
  );
}

function union(
  name: string,
  cases: [caseName: string, payload: xdr.ScSpecTypeDef][],
): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtUnionV0(
    new xdr.ScSpecUdtUnionV0({
      doc: '',
      lib: '',
      name,
      cases: cases.map(([n, payload]) =>
        xdr.ScSpecUdtUnionCaseV0.scSpecUdtUnionCaseTupleV0(
          new xdr.ScSpecUdtUnionCaseTupleV0({ doc: '', name: n, type: [payload] }),
        ),
      ),
    }),
  );
}

function errorEnum(name: string, cases: string[]): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryUdtErrorEnumV0(
    new xdr.ScSpecUdtErrorEnumV0({
      doc: '',
      lib: '',
      name,
      cases: cases.map(
        (n, i) => new xdr.ScSpecUdtErrorEnumCaseV0({ doc: '', name: n, value: i + 1 }),
      ),
    }),
  );
}

/** A spec shaped like `parseContractSpec`'s output: raw entries, empty views. */
function specOf(entries: xdr.ScSpecEntry[]): ContractSpec {
  return {
    wasmHash: '00',
    entries,
    spec: new contract.Spec(entries),
    functions: [],
    types: [],
    errors: [],
    events: [],
    warnings: [],
    sdkVersion: 'test',
  };
}

const edgeBetween = (edges: readonly GraphEdge[], from: string, to: string) =>
  edges.find((e) => e.from === from && e.to === to);

const ids = (nodes: readonly GraphNode[]) => nodes.map((n) => n.id);

// --- the on-chain fixtures --------------------------------------------------

test('Identity Registry: 8 function nodes, no type nodes, no edges; the error enum stays in errors', () => {
  const graph = buildContractGraph(fixtureSpec('identity-registry'));

  assert.equal(graph.nodes.filter((n) => n.kind === 'function').length, 8);
  assert.equal(graph.nodes.filter((n) => n.kind !== 'function').length, 0);
  assert.deepEqual(graph.edges, []);
  assert.ok(graph.errors.length > 0, 'the error enum cases are carried alongside');
  assert.ok(graph.errors.every((e) => e.enumName.length > 0));
});

test('types_zoo: a three-deep struct nest becomes a chain of field edges', () => {
  const graph = buildContractGraph(fixtureSpec('types_zoo'));

  const chain = graph.edges.filter((e) => e.kinds.includes('field'));
  assert.deepEqual(
    chain.map((e) => [e.from, e.to]),
    [
      [typeNodeId('Level1'), typeNodeId('Level2')],
      [typeNodeId('Level2'), typeNodeId('Level3')],
    ],
  );
  assert.deepEqual(chain[0]?.roles, [{ kind: 'field', path: 'Level2', via: 'inner' }]);

  const nested = edgeBetween(graph.edges, functionNodeId('nested'), typeNodeId('Level1'));
  assert.deepEqual(nested?.kinds, ['arg', 'return']);
});

test('types_zoo: node order follows spec order, functions first, ids are stable strings', () => {
  const spec = fixtureSpec('types_zoo');
  const views = buildSpecViews(spec.entries);
  const graph = buildContractGraph(spec);

  assert.deepEqual(ids(graph.nodes), [
    ...views.functions.map((f) => `fn:${f.name}`),
    ...views.types.map((t) => `type:${t.name}`),
  ]);
  assert.equal(new Set(ids(graph.nodes)).size, graph.nodes.length, 'ids are unique');
});

test('an error enum is listed, not drawn: Result<_, Error> adds no node and no edge', () => {
  const graph = buildContractGraph(fixtureSpec('types_zoo'));
  assert.ok(graph.errors.length > 0);
  assert.equal(graph.nodes.filter((n) => n.kind === 'missing').length, 0);
  for (const e of graph.errors) {
    assert.equal(
      graph.nodes.some((n) => n.id === typeNodeId(e.enumName)),
      false,
    );
  }
});

// --- hand-built shapes --------------------------------------------------------

test('Option<Vec<UDT>> is unwrapped to the UDT underneath and remembers its path', () => {
  const graph = buildContractGraph(
    specOf([
      struct('Pool', [['id', u32()]]),
      fn('deposit', [['pools', option(vec(udt('Pool')))]], []),
    ]),
  );

  const edge = edgeBetween(graph.edges, 'fn:deposit', 'type:Pool');
  assert.deepEqual(edge?.roles, [{ kind: 'arg', path: 'Option<Vec<Pool>>', via: 'pools' }]);
  assert.deepEqual(edge?.kinds, ['arg']);
});

test('one function using a type more than once yields a single edge carrying every role', () => {
  const graph = buildContractGraph(
    specOf([
      struct('Pool', [['id', u32()]]),
      fn(
        'swap',
        [
          ['from', udt('Pool')],
          ['to', udt('Pool')],
        ],
        [vec(udt('Pool'))],
      ),
    ]),
  );

  const toPool = graph.edges.filter((e) => e.from === 'fn:swap' && e.to === 'type:Pool');
  assert.equal(toPool.length, 1);
  assert.deepEqual(toPool[0]?.kinds, ['arg', 'return']);
  assert.deepEqual(toPool[0]?.roles, [
    { kind: 'arg', path: 'Pool', via: 'from' },
    { kind: 'arg', path: 'Pool', via: 'to' },
    { kind: 'return', path: 'Vec<Pool>' },
  ]);
});

test('one reference mentioning two types, Map<K, V>, fans out to two edges', () => {
  const graph = buildContractGraph(
    specOf([
      struct('Pool', [['id', u32()]]),
      struct('Token', [['id', u32()]]),
      fn('prices', [], [map(udt('Pool'), udt('Token'))]),
    ]),
  );

  for (const target of ['Pool', 'Token']) {
    const edge = edgeBetween(graph.edges, 'fn:prices', typeNodeId(target));
    assert.deepEqual(edge?.roles, [{ kind: 'return', path: 'Map<Pool, Token>' }]);
  }
});

test('union arms and struct fields both produce field edges', () => {
  const graph = buildContractGraph(
    specOf([
      struct('Leg', [['id', u32()]]),
      union('Route', [['Direct', udt('Leg')]]),
      struct('Order', [['route', option(udt('Route'))]]),
    ]),
  );

  assert.deepEqual(edgeBetween(graph.edges, 'type:Route', 'type:Leg')?.roles, [
    { kind: 'field', path: 'Leg', via: 'Direct.0' },
  ]);
  assert.deepEqual(edgeBetween(graph.edges, 'type:Order', 'type:Route')?.roles, [
    { kind: 'field', path: 'Option<Route>', via: 'route' },
  ]);
});

test('a recursive type keeps its self edge instead of looping', () => {
  const graph = buildContractGraph(
    specOf([struct('Node', [['children', vec(udt('Node'))]]), fn('root', [], [udt('Node')])]),
  );

  assert.deepEqual(edgeBetween(graph.edges, 'type:Node', 'type:Node')?.roles, [
    { kind: 'field', path: 'Vec<Node>', via: 'children' },
  ]);
});

test('a reference to an undefined type becomes a missing node, not a throw', () => {
  const graph = buildContractGraph(specOf([fn('ghost', [['g', udt('Phantom')]], [])]));

  assert.deepEqual(graph.nodes.at(-1), { id: 'type:Phantom', kind: 'missing', name: 'Phantom' });
  assert.deepEqual(edgeBetween(graph.edges, 'fn:ghost', 'type:Phantom')?.kinds, ['arg']);
});

test('Result<_, ErrorEnum> draws no edge and no missing node, even for an empty error enum', () => {
  const graph = buildContractGraph(
    specOf([
      struct('Pool', [['id', u32()]]),
      errorEnum('PoolError', ['Empty']),
      errorEnum('NeverRaised', []),
      fn('take', [], [result(udt('Pool'), udt('PoolError'))]),
      fn('give', [], [result(u32(), udt('NeverRaised'))]),
    ]),
  );

  assert.deepEqual(
    graph.edges.map((e) => e.id),
    ['fn:take->type:Pool'],
  );
  assert.equal(graph.nodes.filter((n) => n.kind === 'missing').length, 0);
  assert.deepEqual(
    graph.errors.map((e) => e.enumName),
    ['PoolError'],
  );
});

test('a duplicated definition keeps the first and adds no duplicate node or edge', () => {
  const graph = buildContractGraph(
    specOf([
      struct('Pool', [['id', u32()]]),
      struct('Pool', [['other', u32()]]),
      struct('Wrapper', [['p', udt('Pool')]]),
      fn('twice', [], []),
      fn('twice', [['p', udt('Pool')]], []),
    ]),
  );

  assert.equal(ids(graph.nodes).filter((id) => id === 'type:Pool').length, 1);
  assert.equal(ids(graph.nodes).filter((id) => id === 'fn:twice').length, 1);
  assert.equal(graph.edges.filter((e) => e.from === 'fn:twice').length, 0, 'first definition wins');
});

// --- determinism and passthrough ---------------------------------------------

test('output is identical across calls and serialises identically', () => {
  const spec = fixtureSpec('types_zoo');
  const first = buildContractGraph(spec);
  const second = buildContractGraph(spec);

  assert.deepStrictEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('errors, events and build pass through unchanged from a populated spec', () => {
  const entries = fixtureSpec('errors_multi').entries;
  const views = buildSpecViews(entries);
  const events: ContractSpec['events'] = [
    { name: 'Moved', doc: '', prefixTopics: [], params: [], dataFormat: 'single_value' },
  ];
  const build = { rustVersion: '1.91.1', entries: { rsver: '1.91.1' } };
  const spec: ContractSpec = { ...specOf([...entries]), ...views, events, build };

  const graph = buildContractGraph(spec);

  assert.equal(graph.errors, spec.errors);
  assert.equal(graph.events, spec.events);
  assert.equal(graph.build, spec.build);
});

test('a populated spec and its raw entries produce the same graph', () => {
  const entries = fixtureSpec('types_zoo').entries;
  const fromEntries = buildContractGraph(specOf([...entries]));
  const fromViews = buildContractGraph({ ...specOf([...entries]), ...buildSpecViews(entries) });

  assert.deepStrictEqual(fromViews, fromEntries);
});
