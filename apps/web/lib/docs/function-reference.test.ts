import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseContractSpec, toSpecJson, type SpecFunction, type TypeRef } from '@signet/spec';
import { withFlattenedViews } from '../contract-overview.ts';
import { typeAnchor } from './anchors.ts';
import {
  CONSTRUCTOR_NOTE,
  buildFunctionReference,
  typesTabHref,
  type FunctionReferenceSpec,
} from './function-reference.ts';

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

const TYPES_HREF = typesTabHref('dev', 'CABC');

function fn(name: string, outputs: TypeRef[], inputs: SpecFunction['inputs'] = []): SpecFunction {
  return { name, doc: '', isConstructor: name === '__constructor', inputs, outputs };
}

function spec(
  functions: SpecFunction[],
  extra: Partial<FunctionReferenceSpec> = {},
): FunctionReferenceSpec {
  return { functions, types: [], errors: [], ...extra };
}

test('registry fixture: one section per function, in declaration order', () => {
  const reference = buildFunctionReference(fixture('identity-registry'), TYPES_HREF);
  assert.equal(reference.ctor, null);
  assert.equal(reference.functions.length, 8);
  assert.deepEqual(
    reference.functions.map((s) => s.name),
    ['claim', 'count', 'lookup', 'release', 'resolve', 'is_bound', 'initialize', 'admin_revoke'],
  );
  assert.deepEqual(
    reference.functions.map((s) => s.id),
    reference.functions.map((s) => `fn-${s.name}`),
  );
});

test('registry fixture: claim renders its signature exactly', () => {
  const claim = buildFunctionReference(fixture('identity-registry'), TYPES_HREF).functions.find(
    (s) => s.name === 'claim',
  )!;
  assert.equal(
    claim.signatureText,
    'claim(handle: String, wallet: Address) -> Result<(), Error>',
  );
  assert.deepEqual(
    claim.args.map((a) => [a.name, a.type.map((p) => p.text).join('')]),
    [
      ['handle', 'String'],
      ['wallet', 'Address'],
    ],
  );
});

test('a function that returns an error carries the Can fail with line, with the scope caveat', () => {
  const registry = fixture('identity-registry');
  const reference = buildFunctionReference(registry, TYPES_HREF);
  const claim = reference.functions.find((s) => s.name === 'claim')!;
  assert.ok(claim.canFail);
  assert.equal(claim.canFail.enums.length, 1);
  assert.equal(claim.canFail.enums[0]!.name, 'Error');
  assert.equal(claim.canFail.enums[0]!.cases.length, 7);
  assert.match(claim.canFail.note, /not which ones this function returns/);

  // A function whose return type has no error gets no such line.
  assert.equal(reference.functions.find((s) => s.name === 'count')!.canFail, null);
});

test('registry fixture: no section carries a placeholder or an empty doc', () => {
  const reference = buildFunctionReference(fixture('identity-registry'), TYPES_HREF);
  for (const s of reference.functions) {
    assert.ok(s.doc === null || s.doc.trim().length > 0, s.name);
    assert.doesNotMatch(s.signatureText, /No description|undefined|null/);
  }
});

test('undocumented fixture: every function still renders in full, with no doc', () => {
  const undocumented = fixture('undocumented');
  const reference = buildFunctionReference(undocumented, TYPES_HREF);
  assert.equal(reference.functions.length, undocumented.functions.length);
  for (const s of reference.functions) {
    assert.equal(s.doc, null, s.name);
    assert.ok(s.signatureText.startsWith(`${s.name}(`), s.name);
  }
});

test('whitespace-only doc comments are absent, not an empty paragraph', () => {
  const blank: SpecFunction = { ...fn('a', ['void']), doc: ' \n\t ' };
  assert.equal(buildFunctionReference(spec([blank]), TYPES_HREF).functions[0]!.doc, null);
});

test('types_zoo: every named type in a signature links to a type the spec defines', () => {
  const zoo = fixture('types_zoo');
  const reference = buildFunctionReference(zoo, TYPES_HREF);
  const defined = new Set(zoo.types.map((t) => typeAnchor(t.name)));
  const named = new Set<string>();
  for (const s of [...reference.functions, ...(reference.ctor ? [reference.ctor] : [])]) {
    for (const part of s.signature) {
      if (!part.href) continue;
      const [base, id] = part.href.split('#');
      assert.equal(base, TYPES_HREF);
      assert.ok(defined.has(id!), `${part.href} points at an element the Types tab renders`);
      assert.equal(id, typeAnchor(part.text));
      named.add(part.text);
    }
  }
  assert.ok(named.size > 0, 'the fixture has signatures that name types');
});

test('a named type the spec does not define stays plain text', () => {
  const named: TypeRef = { type: 'named', name: 'Ghost' };
  const reference = buildFunctionReference(spec([fn('f', [named])]), TYPES_HREF);
  const parts = reference.functions[0]!.signature;
  assert.ok(parts.some((p) => p.text === 'Ghost'));
  assert.ok(parts.every((p) => p.href === undefined));
});

test('a defined named type links through Option, Vec and tuples', () => {
  const pool: TypeRef = { type: 'named', name: 'Pool' };
  const reference = buildFunctionReference(
    spec(
      [
        fn(
          'f',
          [{ type: 'tuple', elements: [pool, 'u32'] }],
          [{ name: 'p', type: { type: 'option', value: { type: 'vec', element: pool } } }],
        ),
      ],
      { types: [{ name: 'Pool' }] },
    ),
    TYPES_HREF,
  );
  const s = reference.functions[0]!;
  assert.equal(s.signatureText, 'f(p: Option<Vec<Pool>>) -> (Pool, u32)');
  assert.deepEqual(
    s.signature.filter((p) => p.href).map((p) => p.href),
    [`${TYPES_HREF}#type-Pool`, `${TYPES_HREF}#type-Pool`],
  );
});

test('the constructor is split out, flagged, and not repeated in the list', () => {
  const reference = buildFunctionReference(
    spec([fn('__constructor', [], [{ name: 'admin', type: 'address' }]), fn('go', ['void'])]),
    TYPES_HREF,
  );
  assert.equal(reference.ctor?.name, '__constructor');
  assert.equal(reference.ctor?.signatureText, '__constructor(admin: Address) -> ()');
  assert.deepEqual(
    reference.functions.map((s) => s.name),
    ['go'],
  );
  assert.match(CONSTRUCTOR_NOTE, /once, when the contract is deployed/);
});

test('a contract with no functions has no sections', () => {
  const reference = buildFunctionReference(spec([]), TYPES_HREF);
  assert.equal(reference.ctor, null);
  assert.deepEqual(reference.functions, []);
});

test('an error return on a contract with no error enum lists nothing, and still says so', () => {
  const reference = buildFunctionReference(spec([fn('f', ['error'])]), TYPES_HREF);
  const canFail = reference.functions[0]!.canFail;
  assert.ok(canFail);
  assert.deepEqual(canFail.enums, []);
});

test('a return typed with one of the contract error enums can fail; one that is not an error enum cannot', () => {
  const errors = [{ enumName: 'ZooError', name: 'Boom', value: 1, doc: '' }];
  const withEnum = fn('f', [{ type: 'result', ok: 'u32', error: { type: 'named', name: 'ZooError' } }]);
  const withOther = fn('g', [{ type: 'named', name: 'Config' }]);
  const reference = buildFunctionReference(
    spec([withEnum, withOther], { errors, types: [{ name: 'Config' }] }),
    TYPES_HREF,
  );
  assert.equal(reference.functions[0]!.canFail?.enums[0]?.name, 'ZooError');
  assert.equal(reference.functions[1]!.canFail, null);
});
