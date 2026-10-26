import assert from 'node:assert/strict';
import test from 'node:test';
import { getOpenApiDocument } from '../api/v1/openapi.ts';
import {
  curlExample,
  exampleFor,
  exampleResponse,
  findOperation,
  listOperations,
  loadApiDocument,
  schemaRows,
  sdkExample,
  typeLabel,
  type ApiDocument,
} from './api-reference.ts';

const doc = loadApiDocument();

test('the reference is the committed snapshot, which matches the served document', () => {
  // CI keeps the snapshot equal to openapi.ts; the pages read the snapshot.
  assert.deepEqual(doc, JSON.parse(JSON.stringify(getOpenApiDocument())));
});

test('one page per operation, with unique ids', () => {
  const ops = listOperations(doc);
  const ids = ops.map((o) => o.operationId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('getProfileContract'));
  assert.ok(ids.includes('lookupWallet'));
  assert.equal(
    ops.length,
    Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0),
  );
});

test('every curl example calls /api/v1 with the parameters filled in', () => {
  for (const op of listOperations(doc)) {
    const curl = curlExample('https://signet.example/api/v1', op);
    assert.match(curl, /^curl -s .*"https:\/\/signet\.example\/api\/v1\//, op.operationId);
    assert.doesNotMatch(curl, /\{\w+\}/, `${op.operationId} leaves a placeholder`);
  }
  const lookup = curlExample('https://x/api/v1', findOperation(doc, 'lookupWallet')!);
  assert.match(lookup, /\/lookup\/G[A-Z2-7]{55}"/);
  const contracts = curlExample('https://x/api/v1', findOperation(doc, 'getProfileContracts')!);
  assert.match(contracts, /\/profiles\/alice\/contracts\?limit=25"/);
});

test('SDK examples name real SDK methods', async () => {
  const { SignetClient } = await import('@signet/sdk');
  for (const op of listOperations(doc)) {
    const sdk = sdkExample('https://signet.example', op);
    if (!sdk) continue;
    const method = /signet\.(\w+)\(/.exec(sdk)![1]!;
    assert.equal(
      typeof (SignetClient.prototype as unknown as Record<string, unknown>)[method],
      'function',
      method,
    );
  }
  assert.equal(sdkExample('x', findOperation(doc, 'getBadge')!), null);
});

test('the schema table flattens nested fields and resolves refs and allOf', () => {
  const op = findOperation(doc, 'getProfileContract')!;
  const rows = schemaRows(doc, op.responses['200']!.content!['application/json']!.schema);
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('data'));
  assert.ok(names.includes('data.attribution.method'), names.join(', '));
  const method = rows.find((r) => r.name === 'data.attribution.method')!;
  assert.equal(method.type, '"indexer" | "deployer-check"');
  assert.equal(method.depth, 2);
  assert.equal(rows.find((r) => r.name === 'data.handle')!.required, true);
});

test('example responses validate as JSON and use the example values', () => {
  for (const op of listOperations(doc)) {
    const ex = exampleResponse(doc, op);
    if (ex) JSON.parse(ex);
  }
  const ex = JSON.parse(exampleResponse(doc, findOperation(doc, 'getProfileContract')!)!);
  assert.match(ex.data.address, /^C[A-Z2-7]{55}$/);
  assert.equal(ex.data.attribution.method, 'indexer');
});

test('type labels and examples cope with a recursive schema', () => {
  const tiny: ApiDocument = {
    info: { title: 't', version: '1' },
    paths: {},
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            next: { $ref: '#/components/schemas/Node' },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };
  const node = { $ref: '#/components/schemas/Node' };
  assert.equal(typeLabel(tiny, node), 'Node');
  assert.ok(schemaRows(tiny, node).length < 10);
  assert.ok(exampleFor(tiny, node));
});
