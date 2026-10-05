import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseContractSpec,
  toSpecJson,
  type SpecFunction,
  type SpecType,
  type TypeRef,
} from '@signet/spec';
import { withFlattenedViews } from '../contract-overview.ts';
import { typeAnchor } from './anchors.ts';
import { typesTabHref } from './function-reference.ts';
import {
  NO_TYPES_NOTE,
  UNUSED_TYPES_LABEL,
  buildTypeReference,
  missingTypeMessage,
  type TypeReferenceSpec,
} from './type-reference.ts';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'spec',
  'fixtures',
);

function fixture(name: string) {
  return withFlattenedViews(
    toSpecJson(parseContractSpec(readFileSync(join(FIXTURES, `${name}.wasm`)))),
  );
}

const HREF = typesTabHref('dev', 'CABC');
const named = (name: string): TypeRef => ({ type: 'named', name });

function fn(name: string, inputs: TypeRef[], outputs: TypeRef[] = []): SpecFunction {
  return {
    name,
    doc: '',
    isConstructor: false,
    inputs: inputs.map((type, i) => ({ name: `a${i}`, type })),
    outputs,
  };
}

function struct(name: string, fields: [string, TypeRef, string?][], doc?: string): SpecType {
  return {
    kind: 'struct',
    name,
    ...(doc ? { doc } : {}),
    fields: fields.map(([n, type, d]) => ({ name: n, type, ...(d ? { doc: d } : {}) })),
  };
}

function spec(functions: SpecFunction[], types: SpecType[]): TypeReferenceSpec {
  return { functions, types, errors: [] };
}

test('three-level chain: each level is its own entry and nested types are links, not expansions', () => {
  const ref = buildTypeReference(
    spec(
      [fn('f', [named('Outer')])],
      [
        struct('Outer', [['mid', named('Middle')]]),
        struct('Middle', [['inner', named('Inner')]]),
        struct('Inner', [['n', 'u32']]),
      ],
    ),
    HREF,
  );
  assert.deepEqual(
    ref.used.map((t) => t.name),
    ['Inner', 'Middle', 'Outer'],
  );
  assert.equal(ref.unused.length, 0);
  const outer = ref.used.find((t) => t.name === 'Outer');
  assert.equal(outer?.kind, 'struct');
  if (outer?.kind !== 'struct') return;
  // One level inline: Outer lists its field and links to Middle; Middle's fields are not repeated.
  assert.equal(outer.fields.length, 1);
  assert.deepEqual(outer.fields[0]!.type, [{ text: 'Middle', href: `${HREF}#${typeAnchor('Middle')}` }]);
  const middle = ref.used.find((t) => t.name === 'Middle');
  if (middle?.kind !== 'struct') throw new Error('Middle is a struct');
  assert.deepEqual(middle.fields[0]!.type, [{ text: 'Inner', href: `${HREF}#${typeAnchor('Inner')}` }]);
  assert.deepEqual(
    ref.used.map((t) => t.id),
    ['type-Inner', 'type-Middle', 'type-Outer'],
  );
});

test('types are alphabetical regardless of discovery order', () => {
  const ref = buildTypeReference(
    spec(
      [fn('f', [named('Zeta'), named('Alpha')])],
      [struct('Zeta', []), struct('Alpha', []), struct('Mid', [])],
    ),
    HREF,
  );
  assert.deepEqual(
    ref.used.map((t) => t.name),
    ['Alpha', 'Zeta'],
  );
  assert.deepEqual(
    ref.unused.map((t) => t.name),
    ['Mid'],
  );
});

test('an unreferenced type is grouped as unused with a count, not dropped', () => {
  const ref = buildTypeReference(
    spec([fn('f', [named('Used')])], [struct('Used', []), struct('B', []), struct('A', [])]),
    HREF,
  );
  assert.deepEqual(
    ref.unused.map((t) => t.name),
    ['A', 'B'],
  );
  assert.equal(ref.unusedLabel, `${UNUSED_TYPES_LABEL} (2)`);
  assert.equal(ref.isEmpty, false);
});

test('a type reachable only through an unused type is unused too', () => {
  const ref = buildTypeReference(
    spec([fn('f', [])], [struct('Holder', [['x', named('Held')]]), struct('Held', [])]),
    HREF,
  );
  assert.equal(ref.used.length, 0);
  assert.equal(ref.unused.length, 2);
  assert.equal(ref.unusedLabel, `${UNUSED_TYPES_LABEL} (2)`);
});

test('no unused types: no label', () => {
  const ref = buildTypeReference(spec([fn('f', [named('A')])], [struct('A', [])]), HREF);
  assert.equal(ref.unusedLabel, null);
});

test('a dangling reference is reported with the exact sentence, and links nowhere', () => {
  const ref = buildTypeReference(
    spec([fn('f', [named('Ghost')]), fn('g', [named('Real')])], [struct('Real', [['g', named('Ghost')]])]),
    HREF,
  );
  assert.deepEqual(ref.missing, [
    {
      name: 'Ghost',
      before: 'Type ',
      after: " is referenced but not defined in this contract's interface",
    },
  ]);
  assert.equal(
    missingTypeMessage('Ghost'),
    "Type `Ghost` is referenced but not defined in this contract's interface",
  );
  const real = ref.used[0]!;
  if (real.kind !== 'struct') throw new Error('struct');
  assert.deepEqual(real.fields[0]!.type, [{ text: 'Ghost' }]);
  assert.equal(ref.isEmpty, false);
});

test('struct fields carry name, linked type and doc; absent docs are null, not prose', () => {
  const ref = buildTypeReference(
    spec(
      [fn('f', [named('S')])],
      [
        struct(
          'S',
          [
            ['owner', 'address', 'Who owns it.'],
            ['tags', { type: 'vec', element: named('S') }],
          ],
          'A record.',
        ),
      ],
    ),
    HREF,
  );
  const s = ref.used[0]!;
  assert.equal(s.doc, 'A record.');
  if (s.kind !== 'struct') throw new Error('struct');
  assert.deepEqual(s.fields[0], {
    name: 'owner',
    type: [{ text: 'Address' }],
    doc: 'Who owns it.',
  });
  assert.equal(s.fields[1]!.doc, null);
  assert.deepEqual(s.fields[1]!.type.map((p) => p.text).join(''), 'Vec<S>');
  assert.equal(s.fields[1]!.type[1]!.href, `${HREF}#type-S`);
});

test('unions list cases with payload types; enums list variants with discriminants', () => {
  const union: SpecType = {
    kind: 'union',
    name: 'Shape',
    cases: [
      { name: 'Empty', fields: [] },
      { name: 'Circle', doc: 'Round.', fields: [{ name: '0', type: 'u32' }] },
      { name: 'Wrap', fields: [{ name: '0', type: named('Color') }] },
    ],
  };
  const en: SpecType = {
    kind: 'enum',
    name: 'Color',
    variants: [
      { name: 'Red', value: 1 },
      { name: 'Blue', value: 7, doc: ' ' },
    ],
  };
  const ref = buildTypeReference(spec([fn('f', [named('Shape')])], [union, en]), HREF);
  const shape = ref.used.find((t) => t.name === 'Shape');
  if (shape?.kind !== 'union') throw new Error('union');
  assert.deepEqual(
    shape.cases.map((c) => [c.name, c.doc, c.payload.length]),
    [
      ['Empty', null, 0],
      ['Circle', 'Round.', 1],
      ['Wrap', null, 1],
    ],
  );
  assert.equal(shape.cases[2]!.payload[0]!.type[0]!.href, `${HREF}#type-Color`);
  const color = ref.used.find((t) => t.name === 'Color');
  if (color?.kind !== 'enum') throw new Error('enum');
  assert.deepEqual(color.variants, [
    { name: 'Red', value: 1, doc: null },
    { name: 'Blue', value: 7, doc: null },
  ]);
});

test('a cyclic type renders once', () => {
  const ref = buildTypeReference(
    spec([fn('f', [named('A')])], [struct('A', [['b', named('B')]]), struct('B', [['a', named('A')]])]),
    HREF,
  );
  assert.deepEqual(
    ref.used.map((t) => t.name),
    ['A', 'B'],
  );
});

test('a duplicate definition keeps the first, so one id per type', () => {
  const ref = buildTypeReference(
    spec([fn('f', [named('A')])], [struct('A', [['x', 'u32']]), struct('A', [['y', 'u32']])]),
    HREF,
  );
  assert.equal(ref.used.length, 1);
  assert.equal(new Set(ref.used.map((t) => t.id)).size, 1);
});

test('no types and no dangling references: empty, with a note and no entries', () => {
  const ref = buildTypeReference(spec([fn('f', ['u32'])], []), HREF);
  assert.equal(ref.isEmpty, true);
  assert.equal(ref.unusedLabel, null);
  assert.equal(NO_TYPES_NOTE, 'This contract defines no types of its own.');
});

test('registry fixture: no UDTs besides the error enum, so nothing to render under Types', () => {
  const ref = buildTypeReference(fixture('identity-registry'), HREF);
  assert.deepEqual(ref.used, []);
  assert.deepEqual(ref.unused, []);
  assert.deepEqual(ref.missing, []);
  assert.equal(ref.isEmpty, true);
});

test('types_zoo fixture: every defined type has an anchor, split into used and unused', () => {
  const zoo = fixture('types_zoo');
  const ref = buildTypeReference(zoo, HREF);
  const all = [...ref.used, ...ref.unused];
  assert.deepEqual(
    all.map((t) => t.id).sort(),
    [...new Set(zoo.types.map((t) => typeAnchor(t.name)))].sort(),
  );
  assert.deepEqual(ref.missing, []);
  // Links only ever point at ids that exist on the page.
  const ids = new Set(all.map((t) => t.id));
  for (const entry of all) {
    const parts =
      entry.kind === 'struct'
        ? entry.fields.flatMap((f) => f.type)
        : entry.kind === 'union'
          ? entry.cases.flatMap((c) => c.payload.flatMap((p) => p.type))
          : [];
    for (const part of parts) {
      if (part.href) assert.ok(ids.has(part.href.slice(part.href.indexOf('#') + 1)), part.href);
    }
  }
});

test('types_zoo fixture: Level1 -> Level2 -> Level3 is walkable by links; an extra unused type is grouped', () => {
  const zoo = fixture('types_zoo');
  const extended = { ...zoo, types: [...zoo.types, struct('Orphan', [['x', 'u32']])] };
  const ref = buildTypeReference(extended, HREF);
  assert.deepEqual(
    ref.used.map((t) => t.name),
    ['Color', 'Level1', 'Level2', 'Level3', 'Shape'],
  );
  assert.deepEqual(
    ref.unused.map((t) => t.id),
    ['type-Orphan'],
  );
  assert.equal(ref.unusedLabel, `${UNUSED_TYPES_LABEL} (1)`);
  const hrefOf = (name: string) => {
    const e = ref.used.find((t) => t.name === name);
    if (e?.kind !== 'struct') throw new Error(`${name} is a struct`);
    return e.fields.flatMap((f) => f.type).find((p) => p.href)?.href;
  };
  assert.equal(hrefOf('Level1'), `${HREF}#type-Level2`);
  assert.equal(hrefOf('Level2'), `${HREF}#type-Level3`);
  assert.equal(hrefOf('Level3'), undefined);
});
