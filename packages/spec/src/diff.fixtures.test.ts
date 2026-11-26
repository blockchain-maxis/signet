import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  InterfaceUnreadable,
  NoInterface,
  buildEvents,
  diffSpecs,
  fromSpecJson,
  parseContractSpec,
  toSpecJson,
  type SpecJson,
} from './index.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

interface FixtureManifestEntry {
  file: string;
  wasmHash: string;
}

const manifest = JSON.parse(
  readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'),
) as Record<string, FixtureManifestEntry>;

function emptySpecJson(wasmHash: string): SpecJson {
  return {
    schemaVersion: 1,
    wasmHash,
    sdkVersion: 'unavailable',
    entriesXdr: [],
    functions: [],
    types: [],
    errors: [],
    events: [],
    warnings: [],
  };
}

function fixtureSpec(file: string): SpecJson {
  const parsed = parseContractSpec(readFileSync(join(FIXTURES, file)));
  return toSpecJson({ ...parsed, events: buildEvents(parsed.entries) });
}

function loadFixtureOrEmpty(entry: FixtureManifestEntry): SpecJson {
  try {
    return fixtureSpec(entry.file);
  } catch (error) {
    if (error instanceof NoInterface || error instanceof InterfaceUnreadable) {
      return emptySpecJson(entry.wasmHash);
    }
    throw error;
  }
}

const EXPECTED_CHANGES = [
  { kind: 'function-added', path: 'functions.set_mode', breaking: false },
  { kind: 'argument-retyped', path: 'functions.change_amount.inputs[0]', breaking: true },
  { kind: 'documentation-changed', path: 'functions.change_amount.doc', breaking: false },
  { kind: 'variant-added', path: 'types.Mode.variants.Paused', breaking: true },
  { kind: 'field-added', path: 'types.Record.fields.active', breaking: true },
  { kind: 'error-added', path: 'errors.UpgradeError.Conflict', breaking: false },
  { kind: 'event-added', path: 'events.Created', breaking: false },
  { kind: 'event-changed', path: 'events.Updated.params[1]', breaking: true },
];

test('decoded upgrade fixtures produce the expected ordered interface changes', () => {
  const before = fixtureSpec('upgrade_v1.wasm');
  const after = fixtureSpec('upgrade_v2.wasm');
  const result = diffSpecs(before, after);

  assert.deepEqual(
    result.changes.map(({ kind, path, breaking }) => ({ kind, path, breaking })),
    EXPECTED_CHANGES,
  );

  const beforeRead = before.functions.find((fn) => fn.name === 'read');
  const afterRead = after.functions.find((fn) => fn.name === 'read');
  assert.ok(beforeRead && afterRead);
  assert.equal(
    JSON.stringify(beforeRead.inputs[0]?.type),
    JSON.stringify(afterRead.inputs[0]?.type),
    'unchanged named TypeRefs from separate WASM parses serialize identically',
  );
  assert.equal(
    JSON.stringify(beforeRead.inputs[0]?.type),
    JSON.stringify({ type: 'named', name: 'Record' }),
  );
  assert.deepEqual(
    result.changes.filter((change) => change.path.startsWith('functions.read.')),
    [],
    'the unchanged function must not produce a TypeRef-only difference',
  );

  const docChanges = result.changes.filter(
    (change) => change.path === 'functions.change_amount.doc',
  );
  assert.deepEqual(docChanges.map(({ kind, breaking }) => ({ kind, breaking })), [
    { kind: 'documentation-changed', breaking: false },
  ]);

  const eventChange = result.changes.find(
    (change) => change.path === 'events.Updated.params[1]',
  );
  assert.ok(eventChange);
  assert.equal(
    (eventChange.before as SpecJson['events'][number]['params'][number]).location,
    'data',
  );
  assert.equal(
    (eventChange.after as SpecJson['events'][number]['params'][number]).location,
    'topic',
  );
  assert.ok(
    result.changes.some((change) => change.kind === 'event-added' && change.path === 'events.Created'),
    'the new event is reported independently',
  );

  const roundTrippedBefore = toSpecJson(fromSpecJson(before));
  const roundTrippedAfter = toSpecJson(fromSpecJson(after));
  assert.deepEqual(diffSpecs(roundTrippedBefore, roundTrippedAfter), result);
});

test('a doc-only rebuild reports only documentation changes', () => {
  const before = fixtureSpec('upgrade_v1.wasm');
  const after = {
    ...before,
    functions: before.functions.map((fn) =>
      fn.name === 'change_amount'
        ? { ...fn, doc: 'Updated amount documentation.' }
        : fn,
    ),
  };

  assert.deepEqual(diffSpecs(before, after).changes.map(({ kind, path, breaking }) => ({
    kind,
    path,
    breaking,
  })), [
    {
      kind: 'documentation-changed',
      path: 'functions.change_amount.doc',
      breaking: false,
    },
  ]);
});

test('every manifest fixture is self-diff clean', () => {
  for (const [name, entry] of Object.entries(manifest)) {
    const json = loadFixtureOrEmpty(entry);
    assert.deepEqual(diffSpecs(json, json).changes, [], `${name} should have no self-diff`);
  }
});
