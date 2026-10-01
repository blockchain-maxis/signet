import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referencedTypes } from './closure.ts';
import { buildSpecViews } from './views.ts';
import { fixtureEntries } from './test-helpers.ts';
import type { SpecFunction, SpecStruct, SpecType } from './types.ts';

function fn(name: string, ...refs: SpecFunction['outputs']): SpecFunction {
  return {
    name,
    doc: '',
    isConstructor: false,
    inputs: refs.map((type, i) => ({ name: `a${i}`, type })),
    outputs: [],
  };
}
function struct(name: string, ...refs: SpecStruct['fields'][number]['type'][]): SpecStruct {
  return {
    kind: 'struct',
    name,
    doc: '',
    fields: refs.map((type, i) => ({ name: `f${i}`, type })),
  };
}
const named = (name: string) => ({ type: 'named', name }) as const;

test('types_zoo: the closure from one function is exactly the nested struct chain', () => {
  const spec = buildSpecViews(fixtureEntries('types_zoo'));
  const { names, missing } = referencedTypes(spec, ['nested']);
  assert.deepEqual(names, ['Level1', 'Level2', 'Level3']);
  assert.deepEqual(missing, []);
  // Types used by other functions are in `types` but outside this closure.
  assert.ok(spec.types.some((t) => t.name === 'Color'));
  assert.ok(!names.includes('Color'));
});

test('types_zoo: default closure covers every function; error enums are not missing', () => {
  const spec = buildSpecViews(fixtureEntries('types_zoo'));
  const { names, missing } = referencedTypes(spec);
  assert.deepEqual([...names].sort(), ['Color', 'Level1', 'Level2', 'Level3', 'Shape']);
  assert.deepEqual(missing, []);
});

test('a type used by no function is present in types but absent from the closure', () => {
  const types: SpecType[] = [struct('Used', 'u32'), struct('Orphan', 'u32')];
  const spec = { functions: [fn('f', named('Used'))], types, errors: [] };
  assert.deepEqual(referencedTypes(spec).names, ['Used']);
  assert.equal(spec.types.length, 2);
});

test('references inside option/result/vec/map/tuple are followed', () => {
  const types: SpecType[] = ['A', 'B', 'C', 'D', 'E'].map((n) => struct(n));
  const spec = {
    functions: [
      fn(
        'f',
        { type: 'option', value: named('A') },
        { type: 'result', ok: named('B'), error: 'error' },
        { type: 'vec', element: named('C') },
        { type: 'map', key: named('D'), value: 'u32' },
        { type: 'tuple', elements: [named('E')] },
      ),
    ],
    types,
    errors: [],
  };
  assert.deepEqual(referencedTypes(spec).names, ['A', 'B', 'C', 'D', 'E']);
});

test('cycles terminate and dangling names are reported as missing', () => {
  const spec = {
    functions: [fn('f', named('A'))],
    types: [
      struct('A', named('B'), named('Ghost')),
      struct('B', named('A'), named('A')),
    ] as SpecType[],
    errors: [],
  };
  const { names, missing } = referencedTypes(spec);
  assert.deepEqual(names, ['A', 'B']);
  assert.deepEqual(missing, ['Ghost']);
});

test('unknown function names are ignored', () => {
  const spec = { functions: [fn('f', named('A'))], types: [struct('A')] as SpecType[], errors: [] };
  assert.deepEqual(referencedTypes(spec, ['nope']), { names: [], missing: [] });
});
