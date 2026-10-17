import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { diffSpecs } from './diff.ts';
import type { SpecJson } from './json.ts';
import { toSpecJson } from './json.ts';
import { parseContractSpec } from './parse.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function spec(overrides: Partial<SpecJson> = {}): SpecJson {
  return {
    schemaVersion: 1,
    wasmHash: 'test',
    sdkVersion: 'test',
    entriesXdr: [],
    functions: [],
    types: [],
    errors: [],
    events: [],
    warnings: [],
    ...overrides,
  };
}

function fn(
  name: string,
  inputs: SpecJson['functions'][number]['inputs'] = [],
  outputs: SpecJson['functions'][number]['outputs'] = [],
  doc = '',
): SpecJson['functions'][number] {
  return { name, doc, isConstructor: false, inputs, outputs };
}

function kinds(before: SpecJson, after: SpecJson): string[] {
  return diffSpecs(before, after).changes.map((change) => change.kind);
}

test('identical specs produce no changes', () => {
  const value = spec({ functions: [fn('hello')] });
  assert.deepEqual(diffSpecs(value, value).changes, []);
});

test('detects added and removed functions', () => {
  assert.ok(kinds(spec(), spec({ functions: [fn('newFn')] })).includes('function-added'));
  assert.ok(kinds(spec({ functions: [fn('oldFn')] }), spec()).includes('function-removed'));
});

test('detects argument changes', () => {
  const original = fn('run', [{ name: 'count', type: 'u32' }]);

  assert.ok(kinds(spec({ functions: [original] }), spec({
    functions: [fn('run', [
      { name: 'count', type: 'u32' },
      { name: 'extra', type: 'bool' },
    ])],
  })).includes('argument-added'));

  assert.ok(kinds(spec({ functions: [fn('run', [
    { name: 'count', type: 'u32' },
    { name: 'extra', type: 'bool' },
  ])] }), spec({ functions: [original] })).includes('argument-removed'));

  assert.ok(kinds(spec({ functions: [original] }), spec({
    functions: [fn('run', [{ name: 'amount', type: 'u32' }])],
  })).includes('argument-renamed'));

  assert.ok(kinds(spec({ functions: [original] }), spec({
    functions: [fn('run', [{ name: 'count', type: 'u64' }])],
  })).includes('argument-retyped'));
});

test('detects return-type and documentation changes', () => {
  assert.ok(kinds(
    spec({ functions: [fn('run', [], ['u32'])] }),
    spec({ functions: [fn('run', [], ['u64'])] }),
  ).includes('return-type-changed'));

  assert.ok(kinds(
    spec({ functions: [fn('run', [], [], 'Before')] }),
    spec({ functions: [fn('run', [], [], 'After')] }),
  ).includes('documentation-changed'));
});

test('detects added, removed and changed types', () => {
  const before = spec({
    types: [
      { kind: 'struct', name: 'OldType', fields: [] },
      { kind: 'struct', name: 'ChangeMe', fields: [] },
    ],
  });

  const after = spec({
    types: [
      { kind: 'struct', name: 'NewType', fields: [] },
      { kind: 'enum', name: 'ChangeMe', variants: [] },
    ],
  });

  const found = kinds(before, after);
  assert.ok(found.includes('type-added'), found.join(', '));
  assert.ok(found.includes('type-removed'), found.join(', '));
  assert.ok(found.includes('type-changed'), found.join(', '));
});

test('detects struct field changes', () => {
  const before = spec({
    types: [{
      kind: 'struct',
      name: 'Record',
      fields: [
        { name: 'id', type: 'u32' },
        { name: 'legacy', type: 'bool' },
      ],
    }],
  });

  const after = spec({
    types: [{
      kind: 'struct',
      name: 'Record',
      fields: [
        { name: 'key', type: 'u64' },
        { name: 'active', type: 'bool' },
        { name: 'extra', type: 'symbol' },
      ],
    }],
  });

  const found = kinds(before, after);
  assert.ok(found.includes('field-renamed'), found.join(', '));
  assert.ok(found.includes('field-retyped'), found.join(', '));
  assert.ok(found.includes('field-added'), found.join(', '));

  assert.ok(kinds(
    spec({ types: [{ kind: 'struct', name: 'S', fields: [{ name: 'x', type: 'u32' }] }] }),
    spec({ types: [{ kind: 'struct', name: 'S', fields: [] }] }),
  ).includes('field-removed'));
});

test('detects union case changes', () => {
  const before = spec({
    types: [{
      kind: 'union',
      name: 'Choice',
      cases: [
        { name: 'First', fields: [] },
        { name: 'Legacy', fields: [] },
      ],
    }],
  });

  const after = spec({
    types: [{
      kind: 'union',
      name: 'Choice',
      cases: [
        { name: 'Second', fields: [] },
      ],
    }],
  });

  const found = kinds(before, after);
  assert.ok(found.includes('case-added'), found.join(', '));
  assert.ok(found.includes('case-removed'), found.join(', '));
});

test('detects enum variant additions, removals and renumbering', () => {
  const before = spec({
    types: [{
      kind: 'enum',
      name: 'Status',
      variants: [
        { name: 'Ready', value: 0 },
        { name: 'Legacy', value: 1 },
      ],
    }],
  });

  const after = spec({
    types: [{
      kind: 'enum',
      name: 'Status',
      variants: [
        { name: 'Ready', value: 5 },
        { name: 'New', value: 6 },
      ],
    }],
  });

  const found = kinds(before, after);
  assert.ok(found.includes('variant-added'), found.join(', '));
  assert.ok(found.includes('variant-removed'), found.join(', '));
  assert.ok(found.includes('variant-renumbered'), found.join(', '));
});

test('detects error additions, removals and renumbering', () => {
  const before = spec({
    errors: [
      { enumName: 'ContractError', name: 'Old', value: 1, doc: '' },
      { enumName: 'ContractError', name: 'Changed', value: 2, doc: '' },
    ],
  });

  const after = spec({
    errors: [
      { enumName: 'ContractError', name: 'Changed', value: 9, doc: '' },
      { enumName: 'ContractError', name: 'New', value: 3, doc: '' },
    ],
  });

  const found = kinds(before, after);
  assert.ok(found.includes('error-added'), found.join(', '));
  assert.ok(found.includes('error-removed'), found.join(', '));
  assert.ok(found.includes('error-renumbered'), found.join(', '));
});

test('smoke-tests real WASM fixtures', () => {
  const registry = toSpecJson(parseContractSpec(
    readFileSync(join(FIXTURES, 'identity-registry.wasm')),
  ));
  const zoo = toSpecJson(parseContractSpec(
    readFileSync(join(FIXTURES, 'types_zoo.wasm')),
  ));

  assert.deepEqual(diffSpecs(registry, registry).changes, []);

  const result = diffSpecs(registry, zoo);
  const kinds = new Set(result.changes.map((change) => change.kind));

  assert.ok(result.changes.length > 0, 'Expected differences between fixtures');
  assert.ok(kinds.has('function-removed'), 'Expected removed functions');
  assert.ok(kinds.has('function-added'), 'Expected added functions');
  assert.ok(kinds.has('type-added'), 'Expected added types');
  assert.ok(kinds.has('error-added'), 'Expected added errors');
  assert.ok(kinds.has('error-removed'), 'Expected removed errors');
  assert.ok(
    !kinds.has('spec-entries-changed'),
    'Expected detailed interface changes rather than a raw-entry fallback',
  );

  for (const change of result.changes) {
    assert.equal(typeof change.breaking, 'boolean');
    assert.ok(change.reason.trim().length > 0);
  }
});

test('detects contract event changes', () => {
  const base = toSpecJson(parseContractSpec(
    readFileSync(join(FIXTURES, 'identity-registry.wasm')),
  ));

  const original = {
    ...base,
    events: [{
      name: 'Transfer',
      doc: 'Transfer event',
      prefixTopics: ['transfer'],
      params: [],
      dataFormat: 'single_value' as const,
    }],
  };

  const changed = {
    ...original,
    events: original.events.map((event) => ({
      ...event,
      doc: 'Updated transfer event',
    })),
  };

  const result = diffSpecs(original, changed);
  assert.ok(
    result.changes.some((change) => change.kind === 'event-changed'),
    'Expected an event change to be reported',
  );
});
