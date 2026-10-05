import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContractGraph } from './graph.ts';
import { groupFunctions } from './group.ts';
import { layoutContractGraph } from './layout.ts';
import { buildTypeGraph } from './type-graph.ts';
import { FIXTURES_DIR, loadFixture, readFixture } from './load-fixture.ts';

const REGISTRY = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.spec.json'))
    .map((f) => f.slice(0, -'.spec.json'.length))
    .sort();
}

// --- the fixtures themselves -------------------------------------------------

test('every fixture has the documented shape and decodes offline', () => {
  const names = fixtureNames();
  assert.ok(names.length >= 3, 'registry plus at least two other real contracts');
  for (const name of names) {
    const fixture = readFixture(name);
    assert.deepEqual(
      Object.keys(fixture).sort(),
      ['address', 'capturedAtLedger', 'entriesXdrBase64', 'network', 'wasmHash'],
      name,
    );
    assert.match(fixture.address, /^C[A-Z2-7]{55}$/, name);
    assert.match(fixture.wasmHash, /^[0-9a-f]{64}$/, name);
    assert.ok(Number.isInteger(fixture.capturedAtLedger) && fixture.capturedAtLedger > 0, name);
    assert.ok(fixture.entriesXdrBase64.length > 0, name);

    const spec = loadFixture(name);
    assert.equal(spec.wasmHash, fixture.wasmHash, name);
    assert.equal(spec.entries.length, fixture.entriesXdrBase64.length, name);
  }
});

test('the README records every fixture address, network, ledger and wasm hash', () => {
  const readme = readFileSync(join(FIXTURES_DIR, 'README.md'), 'utf8');
  for (const name of fixtureNames()) {
    const fixture = readFixture(name);
    assert.ok(readme.includes(fixture.address), `${name}: address`);
    assert.ok(readme.includes(fixture.network), `${name}: network`);
    assert.ok(readme.includes(String(fixture.capturedAtLedger)), `${name}: ledger`);
    assert.ok(readme.includes(fixture.wasmHash), `${name}: wasm hash`);
  }
});

test('loadFixture: the Identity Registry has 8 functions and 1 error enum (design section 1)', () => {
  const fixture = readFixture('identity-registry');
  assert.equal(fixture.address, REGISTRY);
  assert.equal(fixture.network, 'testnet');

  const spec = loadFixture('identity-registry');
  assert.equal(spec.functions.length, 8);
  assert.equal(spec.types.length, 0, 'no user-defined structs, unions or enums');
  assert.equal(new Set(spec.errors.map((e) => e.enumName)).size, 1);
  assert.ok(spec.errors.length > 0);
});

test('loadFixture: a missing fixture throws instead of returning an empty spec', () => {
  assert.throws(() => loadFixture('does-not-exist'), /ENOENT/);
});

test('the fixture set covers a mid-size contract with structs and unions', () => {
  const mid = fixtureNames()
    .map((name) => loadFixture(name))
    .filter((spec) => spec.functions.length >= 15 && spec.functions.length <= 30);
  assert.ok(mid.length > 0, 'a 15 to 30 function contract');
  assert.ok(
    mid.some(
      (spec) =>
        spec.types.some((t) => t.kind === 'struct') && spec.types.some((t) => t.kind === 'union'),
    ),
    'with both structs and unions',
  );
});

// --- the fixtures drive the visualiser pipeline ------------------------------

test('graph: one node per function and per type, no missing types, in every fixture', () => {
  for (const name of fixtureNames()) {
    const spec = loadFixture(name);
    const graph = buildContractGraph(spec);
    assert.equal(graph.nodes.length, spec.functions.length + spec.types.length, name);
    assert.equal(
      graph.nodes.filter((n) => n.kind === 'missing').length,
      0,
      `${name}: every referenced type is defined in the spec`,
    );
    assert.equal(graph.errors.length, spec.errors.length, name);
  }
});

test('layout: every fixture lays out with unique ids and an edge only between known nodes', () => {
  for (const name of fixtureNames()) {
    const graph = buildContractGraph(loadFixture(name));
    const model = layoutContractGraph(graph);
    const ids = new Set(model.nodes.map((n) => n.id));
    assert.equal(ids.size, graph.nodes.length, name);
    for (const edge of model.edges) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to), `${name}: ${edge.id}`);
    }
    assert.ok(model.width > 0 && model.height > 0, name);
  }
});

test('layout: the registry is one column; a contract with types needs more', () => {
  const columns = (name: string) =>
    new Set(layoutContractGraph(buildContractGraph(loadFixture(name))).nodes.map((n) => n.column))
      .size;
  assert.equal(columns('identity-registry'), 1);
  for (const name of fixtureNames()) {
    const spec = loadFixture(name);
    if (spec.types.length > 0) assert.ok(columns(name) >= 2, name);
  }
});

test('group: grouping is all-or-nothing and never loses or repeats a function', () => {
  for (const name of fixtureNames()) {
    const spec = loadFixture(name);
    const names = spec.functions.map((f) => f.name);
    const groups = groupFunctions(names);
    if (groups.length === 0) continue;
    assert.ok(groups.length >= 2, `${name}: a single group is left ungrouped`);
    const grouped = groups.flatMap((g) => [...g.functions]);
    assert.deepEqual([...grouped].sort(), [...names].sort(), name);
  }
});

test('type graph: no unresolved references, and nodes are only types the spec defines', () => {
  for (const name of fixtureNames()) {
    const spec = loadFixture(name);
    const graph = buildTypeGraph(spec);
    const defined = new Set(spec.types.map((t) => t.name));
    assert.deepEqual(graph.missing, [], name);
    assert.ok(
      graph.nodes.every((n) => defined.has(n.name)),
      name,
    );
    assert.ok(graph.nodes.length <= spec.types.length, name);
  }
  // The router's structs are all event payloads, so no signature reaches them;
  // the pool's are arguments and returns, and nest.
  assert.equal(buildTypeGraph(loadFixture('soroswap-router')).nodes.length, 0);
  assert.ok(buildTypeGraph(loadFixture('blend-pool-v1')).nodes.length > 0);
});

// --- no network in tests ------------------------------------------------------

test('no test file imports a network client (the fetch module or an RPC server)', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
  assert.ok(files.length > 0);
  // Patterns are assembled from parts so this file does not match itself.
  const forbidden = [
    new RegExp(`from\\s+['"][^'"]*/${'fe' + 'tch'}(\\.ts)?['"]`),
    new RegExp(`\\b${'rpc'}\\.${'Server'}\\b`),
    new RegExp(`\\b${'new'}\\s+${'Server'}\\(`),
    new RegExp(`import\\s*\\{[^}]*\\b${'Server'}\\b[^}]*\\}\\s*from\\s*['"]@stellar`),
  ];
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${file} matches ${pattern}`);
    }
  }
  assert.ok(existsSync(join(dir, 'load-fixture.ts')));
});
